import * as vscode from 'vscode';
import type { DaemonClient } from '../daemon-client';
import type { CursorAdapter } from '../cursor-adapter';
import type { Session, TranscriptEvent, SessionMode } from '../types';
import {
  CursorComposerStorageReader,
  toSessionMode,
  type ComposerData,
  type ConversationMessage,
} from '../storage-reader';

interface SessionState {
  id: string;
  title: string;
  startTime: number;
  mode: SessionMode;
  lastUpdatedAt?: number;
  /** Track which messageIds we've already sent to avoid duplicates */
  sentMessageIds: Set<string>;
  /** Track last message count to detect new messages */
  lastMessageCount: number;
}

/**
 * CursorOfficialAdapter
 *
 * Uses Cursor's internal commands to observe agent/composer activity.
 * Discovered via VS Code API exploration that composer.getOrderedSelectedComposerIds
 * returns active composer session IDs.
 *
 * Enhanced to read rich metadata and conversation transcripts from Cursor's SQLite storage.
 * Performs startup backfill of existing transcripts so the daemon has complete history.
 */
export function createOfficialAdapter(
  client: DaemonClient,
  context: vscode.ExtensionContext
): CursorAdapter | null {
  const disposables: vscode.Disposable[] = [];

  // Track known sessions by their composer ID
  const knownSessions = new Map<string, SessionState>();
  let pollInterval: NodeJS.Timeout | null = null;
  let fallbackPollInterval: NodeJS.Timeout | null = null;

  // Async storage reader for composer metadata and transcripts
  const storageReader = new CursorComposerStorageReader(context, {
    cacheTtlMs: 2000, // Shorter cache for more responsive transcript updates
  });

  // Guard to prevent overlapping async polls
  let pollInFlight = false;
  
  // Track if file watching is working (fallback to polling if not)
  let fileWatchingActive = false;

  /**
   * Build enriched session from composer data
   */
  function buildEnrichedSession(
    composerId: string,
    composerData: ComposerData | undefined
  ): Omit<Session, 'instanceId'> {
    const mode = toSessionMode(composerData?.unifiedMode);
    const title = composerData?.name || `Composer ${composerId.slice(0, 8)}`;

    return {
      sessionId: composerId,
      title,
      status: 'active',
      mode,
      lastUpdatedAt: composerData?.lastUpdatedAt
        ? new Date(composerData.lastUpdatedAt).toISOString()
        : undefined,
      contextUsagePercent: composerData?.contextUsagePercent,
      totalLinesAdded: composerData?.totalLinesAdded,
      totalLinesRemoved: composerData?.totalLinesRemoved,
      filesChangedCount: composerData?.filesChangedCount,
      subtitle: composerData?.subtitle,
    };
  }

  /**
   * Convert a ConversationMessage to a TranscriptEvent
   */
  function messageToTranscriptEvent(
    sessionId: string,
    message: ConversationMessage
  ): TranscriptEvent {
    const baseEvent: TranscriptEvent = {
      sessionId,
      type: 'message',
      sourceId: message.messageId, // Stable source ID for deduplication
      payload: {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        model: message.model,
      },
    };

    // Handle tool calls specially
    if (message.toolCall) {
      baseEvent.type = message.role === 'tool' ? 'tool_end' : 'tool_start';
      baseEvent.payload = {
        tool: message.toolCall.name,
        args: message.toolCall.args,
        result: message.toolCall.result,
        timestamp: message.timestamp,
      };
    }

    return baseEvent;
  }

  /**
   * Backfill existing transcript messages for a session
   * Called when a new session is detected to sync existing history
   */
  async function backfillTranscript(sessionState: SessionState): Promise<void> {
    try {
      // Clear seen bubbleIds to ensure full backfill (not incremental)
      storageReader.clearSeenBubbleIds(sessionState.id);
      
      const transcript = await storageReader.getConversationTranscript(sessionState.id);
      
      if (transcript.messages.length === 0) {
        console.log(`[Deadhand] No existing transcript for session ${sessionState.id}`);
        return;
      }

      console.log(`[Deadhand] Backfilling ${transcript.messages.length} messages for session ${sessionState.id}`);

      // Send each message with its stable sourceId (daemon will dedupe)
      for (const message of transcript.messages) {
        if (sessionState.sentMessageIds.has(message.messageId)) {
          continue; // Skip if we already sent this
        }

        const event = messageToTranscriptEvent(sessionState.id, message);
        client.sendTranscriptEvent(event);
        sessionState.sentMessageIds.add(message.messageId);
      }

      sessionState.lastMessageCount = transcript.messages.length;
      console.log(`[Deadhand] Backfill complete for session ${sessionState.id}`);
    } catch (err) {
      console.error(`[Deadhand] Error backfilling transcript for ${sessionState.id}:`, err);
    }
  }

  /**
   * Check for and emit new transcript messages for a session
   * @param incremental If true, use incremental reading (only new bubbles)
   */
  async function syncTranscript(sessionState: SessionState, incremental: boolean = false): Promise<void> {
    try {
      const transcript = incremental
        ? await storageReader.getIncrementalTranscript(sessionState.id)
        : await storageReader.getConversationTranscript(sessionState.id);
      
      // Only process if there are new messages
      if (transcript.messages.length === 0) {
        return;
      }

      // Send any messages we haven't sent yet
      let newCount = 0;
      for (const message of transcript.messages) {
        if (sessionState.sentMessageIds.has(message.messageId)) {
          continue;
        }

        const event = messageToTranscriptEvent(sessionState.id, message);
        client.sendTranscriptEvent(event);
        sessionState.sentMessageIds.add(message.messageId);
        newCount++;
      }

      // Update last message count (for non-incremental reads)
      if (!incremental) {
        sessionState.lastMessageCount = transcript.messages.length;
      } else if (newCount > 0) {
        // For incremental, update count by adding new messages
        sessionState.lastMessageCount += newCount;
      }
    } catch (err) {
      // Silently ignore sync errors (will retry on next poll)
    }
  }

  /**
   * Handle transcript change event from file watcher
   */
  async function handleTranscriptChange(composerId: string): Promise<void> {
    // If composerId is empty, check all known sessions
    if (!composerId) {
      for (const [id] of knownSessions) {
        await handleTranscriptChange(id);
      }
      return;
    }

    const sessionState = knownSessions.get(composerId);
    if (!sessionState) {
      return; // Session not tracked yet
    }

    // Use incremental reading for real-time updates
    await syncTranscript(sessionState, true);
  }

  /**
   * Poll for composer sessions using the working Cursor command
   */
  async function pollComposerSessions() {
    // Skip if a poll is already in progress
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;

    try {
      const composerIds = await vscode.commands.executeCommand<string[]>(
        'composer.getOrderedSelectedComposerIds'
      );

      if (!Array.isArray(composerIds)) {
        return;
      }

      // Fetch composer data from SQLite (async, uses internal cache)
      const allComposers = await storageReader.getAllComposers();
      const composerDataMap = new Map(
        allComposers.map((c) => [c.composerId, c])
      );

      const currentIds = new Set(composerIds);

      // Detect new sessions
      for (const composerId of composerIds) {
        const composerData = composerDataMap.get(composerId);

        if (!knownSessions.has(composerId)) {
          // New session detected!
          const mode = toSessionMode(composerData?.unifiedMode);
          const sessionState: SessionState = {
            id: composerId,
            title: composerData?.name || `Composer ${composerId.slice(0, 8)}`,
            startTime: Date.now(),
            mode,
            lastUpdatedAt: composerData?.lastUpdatedAt,
            sentMessageIds: new Set(),
            lastMessageCount: 0,
          };
          knownSessions.set(composerId, sessionState);

          // Notify daemon of new session with rich metadata
          const session = buildEnrichedSession(composerId, composerData);
          client.startSession(session);
          // Best-effort: update model name from Cursor global storage
          storageReader.getComposerModelName(composerId).then((modelName) => {
            if (modelName) {
              client.updateSession({ sessionId: composerId, model: modelName });
            }
          }).catch(() => {});

          console.log(
            `[Deadhand] New composer session detected: ${composerId} (mode: ${mode}, title: ${sessionState.title})`
          );

          // Backfill existing transcript (async, don't await to avoid blocking poll)
          backfillTranscript(sessionState).catch((err) => {
            console.error(`[Deadhand] Backfill error for ${composerId}:`, err);
          });
        } else {
          // Existing session - check for updates
          const known = knownSessions.get(composerId)!;
          const hasChanged =
            composerData?.lastUpdatedAt !== known.lastUpdatedAt ||
            composerData?.name !== known.title;

          if (hasChanged && composerData) {
            // Update local state
            known.title = composerData.name || known.title;
            known.lastUpdatedAt = composerData.lastUpdatedAt;
            known.mode = toSessionMode(composerData.unifiedMode);

            // Send session update to daemon
            client.updateSession({
              sessionId: composerId,
              title: known.title,
              mode: known.mode,
              lastUpdatedAt: composerData.lastUpdatedAt
                ? new Date(composerData.lastUpdatedAt).toISOString()
                : undefined,
              contextUsagePercent: composerData.contextUsagePercent,
              totalLinesAdded: composerData.totalLinesAdded,
              totalLinesRemoved: composerData.totalLinesRemoved,
              filesChangedCount: composerData.filesChangedCount,
              subtitle: composerData.subtitle,
            });
            // Best-effort: refresh model name from Cursor global storage
            storageReader.getComposerModelName(composerId).then((modelName) => {
              if (modelName) {
                client.updateSession({ sessionId: composerId, model: modelName });
              }
            }).catch(() => {});
          }

          // Sync transcript for new messages (safety net).
          // Even when file watching is enabled, SQLite may write to WAL/SHM or coalesce events.
          // Incremental mode minimizes overhead and avoids duplicates.
          syncTranscript(known, true).catch(() => {});
        }
      }

      // Detect ended sessions
      for (const [knownId] of knownSessions.entries()) {
        if (!currentIds.has(knownId)) {
          client.endSession(knownId);
          knownSessions.delete(knownId);
          console.log(`[Deadhand] Composer session ended: ${knownId}`);
        }
      }
    } catch (err) {
      // Silently ignore polling errors
    } finally {
      pollInFlight = false;
    }
  }

  /**
   * Resync all known sessions and their transcripts to the daemon
   * Called after reconnection to ensure daemon has complete state
   */
  async function resyncAllSessions(): Promise<void> {
    console.log(`[Deadhand] Resyncing ${knownSessions.size} sessions to daemon...`);

    // Fetch fresh composer data
    const allComposers = await storageReader.getAllComposers();
    const composerDataMap = new Map(
      allComposers.map((c) => [c.composerId, c])
    );

    // Re-register each known session with fresh metadata
    for (const [composerId, sessionState] of knownSessions) {
      const composerData = composerDataMap.get(composerId);
      const session = buildEnrichedSession(composerId, composerData);
      client.startSession(session);
      // Best-effort: update model name from Cursor global storage
      storageReader.getComposerModelName(composerId).then((modelName) => {
        if (modelName) {
          client.updateSession({ sessionId: composerId, model: modelName });
        }
      }).catch(() => {});

      // Clear seen bubbleIds to force full backfill
      storageReader.clearSeenBubbleIds(composerId);
      
      // Trigger full transcript backfill (daemon will dedupe via sourceId)
      sessionState.sentMessageIds.clear();
      sessionState.lastMessageCount = 0;
      backfillTranscript(sessionState).catch((err) => {
        console.error(`[Deadhand] Resync backfill error for ${composerId}:`, err);
      });
    }

    console.log('[Deadhand] Resync complete');
  }

  return {
    start() {
      console.log('[Deadhand] Starting official adapter with real-time transcript sync...');

      // Start file watching for real-time transcript updates
      try {
        storageReader.startWatching();
        fileWatchingActive = storageReader.isWatching();
        
        if (fileWatchingActive) {
          // Subscribe to transcript change events
          const unsubscribe = storageReader.onTranscriptChange((composerId) => {
            handleTranscriptChange(composerId).catch((err) => {
              console.error('[Deadhand] Error handling transcript change:', err);
            });
          });
          disposables.push({ dispose: unsubscribe });
          
          console.log('[Deadhand] File watching enabled for real-time transcript updates');
        } else {
          console.warn('[Deadhand] File watching not available, falling back to polling');
        }
      } catch (err) {
        console.warn('[Deadhand] File watching failed, falling back to polling:', err);
        fileWatchingActive = false;
      }

      // Initial poll
      pollComposerSessions();

      // Poll for composer sessions every 2 seconds (for session discovery and metadata updates)
      // Transcript sync is now event-driven via file watching
      pollInterval = setInterval(pollComposerSessions, 2000);

      // Fallback polling for transcripts if file watching fails (500ms for active sessions)
      if (!fileWatchingActive) {
        console.log('[Deadhand] Using fallback polling (500ms) for transcript updates');
        fallbackPollInterval = setInterval(() => {
          // Only sync transcripts for known sessions
          for (const [composerId, sessionState] of knownSessions) {
            syncTranscript(sessionState, false).catch(() => {});
          }
        }, 500);
      }

      // Monitor terminal creation for agent activity
      disposables.push(
        vscode.window.onDidOpenTerminal((terminal) => {
          const name = terminal.name.toLowerCase();
          if (
            name.includes('agent') ||
            name.includes('cursor') ||
            name.includes('ai') ||
            name.includes('deadhand')
          ) {
            const activeSession = knownSessions.values().next().value;
            if (activeSession) {
              const event: TranscriptEvent = {
                sessionId: activeSession.id,
                type: 'tool_start',
                sourceId: `terminal-open-${Date.now()}`,
                payload: { tool: 'terminal', args: { name: terminal.name } },
              };
              client.sendTranscriptEvent(event);
            }
          }
        })
      );

      disposables.push(
        vscode.window.onDidCloseTerminal((terminal) => {
          const name = terminal.name.toLowerCase();
          if (
            name.includes('agent') ||
            name.includes('cursor') ||
            name.includes('ai') ||
            name.includes('deadhand')
          ) {
            const activeSession = knownSessions.values().next().value;
            if (activeSession) {
              const event: TranscriptEvent = {
                sessionId: activeSession.id,
                type: 'tool_end',
                sourceId: `terminal-close-${Date.now()}`,
                payload: { tool: 'terminal', result: 'closed' },
              };
              client.sendTranscriptEvent(event);
            }
          }
        })
      );

      // Watch for .cursor file changes (can trigger cache invalidation)
      const watcher = vscode.workspace.createFileSystemWatcher('**/.cursor*');
      disposables.push(watcher);
      disposables.push(
        watcher.onDidChange(() => {
          storageReader.invalidateCache();
        })
      );

      console.log('[Deadhand] Official adapter started with transcript sync');
    },

    stop() {
      // End all known sessions
      for (const [sessionId] of knownSessions) {
        client.endSession(sessionId);
      }
      knownSessions.clear();

      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }

      if (fallbackPollInterval) {
        clearInterval(fallbackPollInterval);
        fallbackPollInterval = null;
      }

      disposables.forEach((d) => d.dispose());
      disposables.length = 0;

      // Close the SQLite connection
      storageReader.dispose().catch((err) => {
        console.error('[Deadhand] Error disposing storage reader:', err);
      });

      console.log('[Deadhand] Official adapter stopped');
    },

    resync() {
      // Trigger full resync (async but don't block)
      resyncAllSessions().catch((err) => {
        console.error('[Deadhand] Resync error:', err);
      });
    },
  };
}

/**
 * Discover available Cursor commands
 * Useful for understanding what APIs might be available
 */
export async function discoverCursorCommands(): Promise<string[]> {
  const allCommands = await vscode.commands.getCommands(true);

  const cursorCommands = allCommands.filter(
    (cmd) =>
      cmd.toLowerCase().includes('cursor') ||
      cmd.toLowerCase().includes('aichat') ||
      cmd.toLowerCase().includes('composer') ||
      cmd.toLowerCase().includes('copilot') ||
      cmd.toLowerCase().includes('agent')
  );

  console.log('[Deadhand] Discovered AI-related commands:', cursorCommands);
  return cursorCommands;
}

/**
 * List all installed extensions that might be relevant
 */
export function discoverAIExtensions(): vscode.Extension<unknown>[] {
  return vscode.extensions.all.filter((ext) => {
    const id = ext.id.toLowerCase();
    return (
      id.includes('cursor') ||
      id.includes('copilot') ||
      id.includes('ai') ||
      id.includes('gpt') ||
      id.includes('claude') ||
      id.includes('anthropic')
    );
  });
}

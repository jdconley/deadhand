/**
 * Cursor Storage Reader
 *
 * Reads session metadata and conversation transcripts from Cursor's internal SQLite storage.
 * Uses @vscode/sqlite3 for async, non-blocking database access.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as zlib from 'zlib';
import { watch, existsSync } from 'fs';
import { Database, OPEN_READONLY } from '@vscode/sqlite3';
import type { SessionMode } from './types';

/** Cache for discovered transcript keys per composerId (survives cache invalidation) */
const discoveredKeyCache = new Map<string, { key: string; timestamp: number }>();
const DISCOVERED_KEY_TTL = 60 * 60 * 1000; // 1 hour

export interface ComposerData {
  composerId: string;
  name?: string;
  unifiedMode?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  contextUsagePercent?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  subtitle?: string;
  hasUnreadMessages?: boolean;
  isArchived?: boolean;
}

/** Represents a message in the conversation */
export interface ConversationMessage {
  /** Stable message ID from Cursor (or derived) */
  messageId: string;
  /** Role: user, assistant, system, tool */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Message content (text) */
  content: string;
  /** Timestamp (ms since epoch, if available) */
  timestamp?: number;
  /** Tool call information (if this is a tool message) */
  toolCall?: {
    name: string;
    args?: Record<string, unknown>;
    result?: string;
  };
  /** Model used (for assistant messages) */
  model?: string;
}

/** Conversation transcript for a composer session */
export interface ConversationTranscript {
  composerId: string;
  messages: ConversationMessage[];
}

export interface StorageReaderOptions {
  /** Cache TTL in milliseconds. Default: 5000 */
  cacheTtlMs?: number;
}

/** Callback type for transcript change events */
export type TranscriptChangeCallback = (composerId: string) => void;

/**
 * Async storage reader for Cursor composer metadata and transcripts.
 * Maintains a persistent read-only DB connection and caches results.
 */
export class CursorComposerStorageReader {
  private context: vscode.ExtensionContext;
  private cacheTtlMs: number;
  // Workspace-scoped state DB (workspaceStorage/<wsId>/state.vscdb)
  private db: Database | null = null;
  private cachedComposers: ComposerData[] | null = null;
  private cacheTimestamp = 0;
  private openPromise: Promise<void> | null = null;

  // Global state DB (globalStorage/state.vscdb) - Cursor stores bubble transcripts here
  private globalDb: Database | null = null;
  private globalOpenPromise: Promise<void> | null = null;
  
  // Cache for conversation transcripts per composerId
  private cachedTranscripts = new Map<string, { data: ConversationTranscript; timestamp: number }>();

  // File watchers for state.vscdb files
  private workspaceWatcher: ReturnType<typeof watch> | null = null;
  private globalWatcher: ReturnType<typeof watch> | null = null;
  private workspaceDirWatcher: ReturnType<typeof watch> | null = null;
  private globalDirWatcher: ReturnType<typeof watch> | null = null;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private readonly WATCH_DEBOUNCE_MS = 50;

  // Event callbacks for transcript changes
  private transcriptChangeCallbacks = new Set<TranscriptChangeCallback>();

  // Track seen bubbleIds per composer (session-scoped optimization)
  private seenBubbleIds = new Map<string, Set<string>>();

  // Track if file watching is enabled and working
  private watchingEnabled = false;
  private watchErrorCount = 0;
  private readonly MAX_WATCH_ERRORS = 5;

  constructor(context: vscode.ExtensionContext, opts?: StorageReaderOptions) {
    this.context = context;
    this.cacheTtlMs = opts?.cacheTtlMs ?? 5000;
  }

  /**
   * Get the workspace storage path from VS Code context
   */
  private getWorkspaceStoragePath(): string | null {
    const storageUri = this.context.storageUri;
    if (storageUri) {
      // The storage URI points to our extension's storage, but we need the parent
      // workspace storage directory to access Cursor's data
      const storagePath = storageUri.fsPath;
      // Go up one level to get to the workspace storage root
      return path.dirname(storagePath);
    }
    return null;
  }

  /**
   * Get the state.vscdb path for the current workspace
   */
  private getStateDbPath(): string | null {
    const workspaceStorage = this.getWorkspaceStoragePath();
    if (!workspaceStorage) {
      return null;
    }
    return path.join(workspaceStorage, 'state.vscdb');
  }

  /**
   * Get the global storage root path from VS Code context
   */
  private getGlobalStorageRootPath(): string | null {
    const globalStorageUri = this.context.globalStorageUri;
    if (!globalStorageUri) return null;
    // globalStorageUri points to this extension's folder under Cursor's User/globalStorage
    return path.dirname(globalStorageUri.fsPath);
  }

  /**
   * Get the global state.vscdb path (Cursor global storage)
   */
  private getGlobalStateDbPath(): string | null {
    const root = this.getGlobalStorageRootPath();
    if (!root) return null;
    return path.join(root, 'state.vscdb');
  }

  /**
   * Start watching state.vscdb files for changes
   */
  startWatching(): void {
    if (this.watchingEnabled) {
      return; // Already watching
    }

    const workspaceDbPath = this.getStateDbPath();
    const globalDbPath = this.getGlobalStateDbPath();
    const workspaceDir = workspaceDbPath ? path.dirname(workspaceDbPath) : null;
    const globalDir = globalDbPath ? path.dirname(globalDbPath) : null;

    try {
      // Watch workspace state.vscdb
      if (workspaceDbPath && existsSync(workspaceDbPath)) {
        this.workspaceWatcher = watch(workspaceDbPath, (eventType, filename) => {
          if (eventType === 'change') {
            this.handleFileChange('workspace');
          }
        });
        this.workspaceWatcher.on('error', (err) => {
          console.warn('[Deadhand] Workspace watcher error:', err);
          this.watchErrorCount++;
          if (this.watchErrorCount >= this.MAX_WATCH_ERRORS) {
            console.warn('[Deadhand] Too many watch errors, stopping file watching');
            this.stopWatching();
          }
        });
        console.log('[Deadhand] Started watching workspace state.vscdb');
      }

      // Watch global state.vscdb (more important for transcripts)
      if (globalDbPath && existsSync(globalDbPath)) {
        this.globalWatcher = watch(globalDbPath, (eventType, filename) => {
          if (eventType === 'change') {
            this.handleFileChange('global');
          }
        });
        this.globalWatcher.on('error', (err) => {
          console.warn('[Deadhand] Global watcher error:', err);
          this.watchErrorCount++;
          if (this.watchErrorCount >= this.MAX_WATCH_ERRORS) {
            console.warn('[Deadhand] Too many watch errors, stopping file watching');
            this.stopWatching();
          }
        });
        console.log('[Deadhand] Started watching global state.vscdb');
      }

      // Also watch the containing directories to catch WAL/SHM changes
      // SQLite often writes to state.vscdb-wal instead of state.vscdb directly.
      if (workspaceDir && existsSync(workspaceDir)) {
        this.workspaceDirWatcher = watch(workspaceDir, (eventType, filename) => {
          if (typeof filename === 'string' && filename.startsWith('state.vscdb')) {
            this.handleFileChange('workspace');
          }
        });
        this.workspaceDirWatcher.on('error', (err) => {
          console.warn('[Deadhand] Workspace dir watcher error:', err);
          this.watchErrorCount++;
          if (this.watchErrorCount >= this.MAX_WATCH_ERRORS) {
            console.warn('[Deadhand] Too many watch errors, stopping file watching');
            this.stopWatching();
          }
        });
        console.log('[Deadhand] Started watching workspace state.vscdb directory');
      }

      if (globalDir && existsSync(globalDir)) {
        this.globalDirWatcher = watch(globalDir, (eventType, filename) => {
          if (typeof filename === 'string' && filename.startsWith('state.vscdb')) {
            this.handleFileChange('global');
          }
        });
        this.globalDirWatcher.on('error', (err) => {
          console.warn('[Deadhand] Global dir watcher error:', err);
          this.watchErrorCount++;
          if (this.watchErrorCount >= this.MAX_WATCH_ERRORS) {
            console.warn('[Deadhand] Too many watch errors, stopping file watching');
            this.stopWatching();
          }
        });
        console.log('[Deadhand] Started watching global state.vscdb directory');
      }

      this.watchingEnabled = true;
      this.watchErrorCount = 0;
    } catch (err) {
      console.warn('[Deadhand] Failed to start file watching:', err);
      this.watchingEnabled = false;
      this.watchErrorCount++;
    }
  }

  /**
   * Stop watching files
   */
  stopWatching(): void {
    if (this.workspaceWatcher) {
      this.workspaceWatcher.close();
      this.workspaceWatcher = null;
    }
    if (this.globalWatcher) {
      this.globalWatcher.close();
      this.globalWatcher = null;
    }
    if (this.workspaceDirWatcher) {
      this.workspaceDirWatcher.close();
      this.workspaceDirWatcher = null;
    }
    if (this.globalDirWatcher) {
      this.globalDirWatcher.close();
      this.globalDirWatcher = null;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    this.watchingEnabled = false;
    console.log('[Deadhand] Stopped watching state.vscdb files');
  }

  /**
   * Load transcript bubbles by scanning bubbleId keys when composerData:<id> is missing.
   * This is slower than using fullConversationHeadersOnly, but works for Cursor variants
   * that omit composerData while still persisting bubbles.
   */
  private async loadTranscriptFromGlobalBubblesOnly(
    composerId: string,
    incremental: boolean
  ): Promise<ConversationMessage[]> {
    const gdb = await this.ensureGlobalOpen();
    const out: ConversationMessage[] = [];

    const seenSet = this.seenBubbleIds.get(composerId) || new Set<string>();

    // Bounded scan to avoid pathological DB sizes; most chats have far fewer bubbles.
    const rows = await this.queryAll<{ key: string; value: unknown }>(
      gdb,
      'SELECT key, value FROM cursorDiskKV WHERE key LIKE ? LIMIT 500',
      [`bubbleId:${composerId}:%`]
    );

    for (const row of rows) {
      if (typeof row.key !== 'string') continue;
      const parts = row.key.split(':');
      const bubbleId = parts[parts.length - 1] || '';
      if (!bubbleId || bubbleId.length < 8) continue;

      if (incremental && seenSet.has(bubbleId)) continue;

      const bubbleJson = this.decodeValue(row.value);
      if (!bubbleJson) continue;

      let bubble: any;
      try {
        bubble = JSON.parse(bubbleJson);
      } catch {
        continue;
      }

      const createdAt = typeof bubble?.createdAt === 'string' ? Date.parse(bubble.createdAt) : undefined;

      // Tool bubble
      const toolFormer = bubble?.toolFormerData;
      if (toolFormer && typeof toolFormer.name === 'string') {
        let parsedArgs: Record<string, unknown> | undefined;
        const rawArgs = toolFormer.rawArgs;
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          try {
            parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            parsedArgs = { raw: rawArgs };
          }
        }

        const toolResult =
          typeof toolFormer.result === 'string'
            ? toolFormer.result
            : typeof toolFormer.output === 'string'
              ? toolFormer.output
              : undefined;

        out.push({
          messageId: bubbleId,
          role: 'tool',
          content: '',
          timestamp: Number.isFinite(createdAt) ? createdAt : undefined,
          model: typeof bubble?.modelInfo?.modelName === 'string' ? bubble.modelInfo.modelName : undefined,
          toolCall: {
            name: toolFormer.name,
            args: parsedArgs,
            result: toolResult,
          },
        });
        seenSet.add(bubbleId);
        continue;
      }

      const text =
        typeof bubble?.text === 'string'
          ? bubble.text
          : typeof bubble?.richText === 'string'
            ? bubble.richText
            : '';

      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        // IMPORTANT: Do NOT mark empty bubbles as seen.
        // Cursor can update an existing bubble record as streaming completes; if we mark it as seen
        // while empty, we'll never pick up the final assistant text later.
        continue;
      }

      // Try to infer role from bubble fields (fallback heuristics)
      const bubbleTypeRaw = bubble?.type ?? bubble?.bubbleType ?? bubble?.roleType;
      const bubbleTypeNum = typeof bubbleTypeRaw === 'number' ? bubbleTypeRaw : NaN;
      const role: ConversationMessage['role'] =
        Number.isFinite(bubbleTypeNum)
          ? bubbleTypeNum === 1
            ? 'user'
            : 'assistant'
          : bubble?.modelInfo
            ? 'assistant'
            : 'user';

      out.push({
        messageId: bubbleId,
        role,
        content: text,
        timestamp: Number.isFinite(createdAt) ? createdAt : undefined,
        model: typeof bubble?.modelInfo?.modelName === 'string' ? bubble.modelInfo.modelName : undefined,
      });
      seenSet.add(bubbleId);
    }

    // Order by timestamp when available
    const hasAnyTs = out.some((m) => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp));
    if (hasAnyTs) {
      out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    }

    if (seenSet.size > 0) {
      this.seenBubbleIds.set(composerId, seenSet);
    }

    return out;
  }

  /**
   * Handle file change event with debouncing
   */
  private handleFileChange(source: 'workspace' | 'global'): void {
    // Debounce rapid file changes
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }

    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      
      // Invalidate cache to force fresh reads
      this.invalidateCache();

      // Notify all subscribers that transcripts may have changed
      // We don't know which composerId changed, so we notify for all active ones
      // The adapter will check each session individually
      this.transcriptChangeCallbacks.forEach((callback) => {
        try {
          // Pass empty string to indicate "check all"
          callback('');
        } catch (err) {
          console.error('[Deadhand] Error in transcript change callback:', err);
        }
      });
    }, this.WATCH_DEBOUNCE_MS);
  }

  /**
   * Subscribe to transcript change events
   * Callback receives composerId (empty string means "check all")
   */
  onTranscriptChange(callback: TranscriptChangeCallback): () => void {
    this.transcriptChangeCallbacks.add(callback);
    
    // Start watching if not already started
    if (!this.watchingEnabled) {
      this.startWatching();
    }

    // Return unsubscribe function
    return () => {
      this.transcriptChangeCallbacks.delete(callback);
    };
  }

  /**
   * Check if file watching is currently active
   */
  isWatching(): boolean {
    return this.watchingEnabled;
  }

  /**
   * Open the database connection (lazy, reused)
   */
  private async ensureOpen(): Promise<Database> {
    // If we have a valid open DB, return it
    if (this.db) {
      return this.db;
    }

    // If we're already opening, wait for that to complete
    if (this.openPromise) {
      await this.openPromise;
      if (this.db) return this.db;
    }

    // Start opening
    this.openPromise = this.openDb();
    await this.openPromise;
    this.openPromise = null;

    if (!this.db) {
      throw new Error('Failed to open database');
    }
    return this.db;
  }

  /**
   * Open the global database connection (lazy, reused)
   */
  private async ensureGlobalOpen(): Promise<Database> {
    if (this.globalDb) {
      return this.globalDb;
    }

    if (this.globalOpenPromise) {
      await this.globalOpenPromise;
      if (this.globalDb) return this.globalDb;
    }

    this.globalOpenPromise = this.openGlobalDb();
    await this.globalOpenPromise;
    this.globalOpenPromise = null;

    if (!this.globalDb) {
      throw new Error('Failed to open global database');
    }
    return this.globalDb;
  }

  /**
   * Actually open the database
   */
  private openDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbPath = this.getStateDbPath();
      if (!dbPath) {
        reject(new Error('Could not determine state.vscdb path'));
        return;
      }

      // Open in read-only mode
      this.db = new Database(
        dbPath,
        OPEN_READONLY,
        (err) => {
          if (err) {
            console.error('[Deadhand] Failed to open SQLite database:', err);
            this.db = null;
            reject(err);
          } else {
            console.log('[Deadhand] SQLite database opened:', dbPath);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Actually open the global database
   */
  private openGlobalDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbPath = this.getGlobalStateDbPath();
      if (!dbPath) {
        reject(new Error('Could not determine global state.vscdb path'));
        return;
      }

      this.globalDb = new Database(
        dbPath,
        OPEN_READONLY,
        (err) => {
          if (err) {
            console.error('[Deadhand] Failed to open GLOBAL SQLite database:', err);
            this.globalDb = null;
            reject(err);
          } else {
            console.log('[Deadhand] GLOBAL SQLite database opened:', dbPath);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Query a single row from the database
   */
  private queryGet<T>(
    db: Database,
    sql: string,
    params: unknown[]
  ): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row as T | undefined);
        }
      });
    });
  }

  /**
   * Query all rows from the database
   */
  private queryAll<T>(
    db: Database,
    sql: string,
    params: unknown[]
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve((rows || []) as T[]);
        }
      });
    });
  }

  /**
   * Check if the cache is still valid
   */
  private isCacheValid(): boolean {
    return (
      this.cachedComposers !== null &&
      Date.now() - this.cacheTimestamp < this.cacheTtlMs
    );
  }

  /**
   * Decode a database value to string, handling various encodings:
   * - Plain UTF-8 string
   * - UTF-8 Buffer
   * - gzip-compressed Buffer
   * - zlib-compressed Buffer (deflate)
   */
  private decodeValue(value: unknown): string | null {
    if (typeof value === 'string') {
      return value;
    }

    if (!Buffer.isBuffer(value)) {
      console.warn('[Deadhand] Unexpected value type:', typeof value);
      return null;
    }

    // Check for gzip magic bytes (1f 8b)
    if (value.length >= 2 && value[0] === 0x1f && value[1] === 0x8b) {
      try {
        const decompressed = zlib.gunzipSync(value);
        return decompressed.toString('utf8');
      } catch (err) {
        console.warn('[Deadhand] gzip decompression failed, trying raw:', err);
      }
    }

    // Check for zlib/deflate magic bytes (78 01, 78 5e, 78 9c, 78 da)
    if (value.length >= 2 && value[0] === 0x78) {
      try {
        const decompressed = zlib.inflateSync(value);
        return decompressed.toString('utf8');
      } catch (err) {
        // Not zlib-compressed, fall through to raw
      }
    }

    // Try raw UTF-8
    try {
      const str = value.toString('utf8');
      // Validate it's valid JSON-ish (starts with { or [)
      const trimmed = str.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return str;
      }
      // Could be some other encoding, log first bytes for debugging
      console.warn('[Deadhand] Buffer does not appear to be JSON, first bytes:', 
        value.slice(0, 16).toString('hex'));
      return str; // Return anyway, let caller handle parse error
    } catch (err) {
      console.error('[Deadhand] Failed to decode buffer:', err);
      return null;
    }
  }

  /**
   * Parse the composer data JSON from the database value
   * Handles both string and Buffer values (including compressed)
   */
  private parseComposerValue(value: unknown): ComposerData[] {
    const jsonString = this.decodeValue(value);
    if (!jsonString) {
      return [];
    }

    try {
      const data = JSON.parse(jsonString);
      if (data && Array.isArray(data.allComposers)) {
        return data.allComposers.map((c: Record<string, unknown>) => ({
          composerId: c.composerId as string,
          name: c.name as string | undefined,
          unifiedMode: c.unifiedMode as string | undefined,
          createdAt: c.createdAt as number | undefined,
          lastUpdatedAt: c.lastUpdatedAt as number | undefined,
          contextUsagePercent: c.contextUsagePercent as number | undefined,
          totalLinesAdded: c.totalLinesAdded as number | undefined,
          totalLinesRemoved: c.totalLinesRemoved as number | undefined,
          filesChangedCount: c.filesChangedCount as number | undefined,
          subtitle: c.subtitle as string | undefined,
          hasUnreadMessages: c.hasUnreadMessages as boolean | undefined,
          isArchived: c.isArchived as boolean | undefined,
        }));
      }
    } catch (err) {
      console.error('[Deadhand] Failed to parse composer data:', err);
    }

    return [];
  }

  /**
   * Parse conversation data from Cursor's storage format
   */
  private parseConversationValue(composerId: string, value: unknown): ConversationMessage[] {
    const jsonString = this.decodeValue(value);
    if (!jsonString) {
      return [];
    }

    try {
      const data = JSON.parse(jsonString);
      const messages: ConversationMessage[] = [];

      // Cursor stores conversations in various formats - try to handle them all
      
      // Format 1: { conversation: [...] } or { messages: [...] } or { bubbles: [...] }
      const rawMessages = data.conversation || data.messages || data.bubbles || [];
      
      if (Array.isArray(rawMessages)) {
        for (let i = 0; i < rawMessages.length; i++) {
          const msg = rawMessages[i];
          const parsed = this.parseMessage(composerId, msg, i);
          if (parsed) {
            messages.push(parsed);
          }
        }
      }

      // Format 2: { richConversation: { bubbles: [...] } }
      if (data.richConversation?.bubbles && Array.isArray(data.richConversation.bubbles)) {
        for (let i = 0; i < data.richConversation.bubbles.length; i++) {
          const bubble = data.richConversation.bubbles[i];
          const parsed = this.parseBubble(composerId, bubble, i);
          if (parsed) {
            messages.push(...parsed);
          }
        }
      }

      // Format 3: Top-level array of messages
      if (Array.isArray(data) && messages.length === 0) {
        for (let i = 0; i < data.length; i++) {
          const msg = data[i];
          const parsed = this.parseMessage(composerId, msg, i);
          if (parsed) {
            messages.push(parsed);
          }
        }
      }

      // Format 4: Nested under "tabs" or "composers" (multi-session storage)
      if (data.tabs && typeof data.tabs === 'object' && messages.length === 0) {
        const tabData = data.tabs[composerId];
        if (tabData) {
          const tabMessages = tabData.conversation || tabData.messages || tabData.bubbles || [];
          if (Array.isArray(tabMessages)) {
            for (let i = 0; i < tabMessages.length; i++) {
              const msg = tabMessages[i];
              const parsed = this.parseMessage(composerId, msg, i);
              if (parsed) {
                messages.push(parsed);
              }
            }
          }
        }
      }

      // Format 5: { composerData: { [id]: { conversation: [...] } } }
      if (data.composerData && typeof data.composerData === 'object' && messages.length === 0) {
        const composerEntry = data.composerData[composerId];
        if (composerEntry) {
          const cMessages = composerEntry.conversation || composerEntry.messages || [];
          if (Array.isArray(cMessages)) {
            for (let i = 0; i < cMessages.length; i++) {
              const msg = cMessages[i];
              const parsed = this.parseMessage(composerId, msg, i);
              if (parsed) {
                messages.push(parsed);
              }
            }
          }
        }
      }

      return messages;
    } catch (err) {
      // Only log if it looks like it should have been JSON
      const trimmed = jsonString.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        console.error('[Deadhand] Failed to parse conversation data:', err);
      }
      return [];
    }
  }

  /**
   * Parse a single message from Cursor's format
   */
  private parseMessage(composerId: string, msg: Record<string, unknown>, index: number): ConversationMessage | null {
    if (!msg) return null;

    // Generate stable ID from composerId + index (or use Cursor's ID if available)
    const messageId = (msg.id as string) || (msg.messageId as string) || `${composerId}-msg-${index}`;
    
    // Determine role
    let role: ConversationMessage['role'] = 'user';
    const rawRole = (msg.role as string) || (msg.type as string) || '';
    if (rawRole.toLowerCase().includes('assistant') || rawRole.toLowerCase().includes('ai')) {
      role = 'assistant';
    } else if (rawRole.toLowerCase().includes('system')) {
      role = 'system';
    } else if (rawRole.toLowerCase().includes('tool') || rawRole.toLowerCase().includes('function')) {
      role = 'tool';
    }

    // Extract content
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (typeof msg.text === 'string') {
      content = msg.text;
    } else if (typeof msg.message === 'string') {
      content = msg.message;
    } else if (Array.isArray(msg.content)) {
      // Handle content arrays (like OpenAI format)
      content = msg.content
        .map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (typeof c === 'object' && c !== null && 'text' in c) return (c as { text: string }).text;
          return '';
        })
        .join('\n');
    }

    if (!content && role !== 'tool') {
      return null;
    }

    const result: ConversationMessage = {
      messageId,
      role,
      content,
      timestamp: (msg.timestamp as number) || (msg.createdAt as number),
      model: msg.model as string | undefined,
    };

    // Handle tool calls
    if (msg.toolCall || msg.tool_calls || msg.functionCall) {
      const toolData = msg.toolCall || msg.tool_calls || msg.functionCall;
      if (typeof toolData === 'object' && toolData !== null) {
        const tool = toolData as Record<string, unknown>;
        result.toolCall = {
          name: (tool.name as string) || (tool.function as string) || 'unknown',
          args: tool.arguments as Record<string, unknown> | undefined,
          result: tool.result as string | undefined,
        };
      }
    }

    return result;
  }

  /**
   * Parse a "bubble" from Cursor's rich conversation format
   */
  private parseBubble(composerId: string, bubble: Record<string, unknown>, index: number): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    // Each bubble can contain multiple parts (user query, assistant response, tool calls, etc.)
    const bubbleId = (bubble.id as string) || `${composerId}-bubble-${index}`;
    
    // User message
    if (bubble.query || bubble.userMessage || bubble.humanMessage) {
      const userContent = (bubble.query as string) || 
                         (bubble.userMessage as string) || 
                         (bubble.humanMessage as string) || '';
      if (userContent) {
        messages.push({
          messageId: `${bubbleId}-user`,
          role: 'user',
          content: userContent,
          timestamp: bubble.timestamp as number | undefined,
        });
      }
    }

    // Assistant message
    if (bubble.response || bubble.aiMessage || bubble.assistantMessage || bubble.text) {
      const assistantContent = (bubble.response as string) || 
                              (bubble.aiMessage as string) || 
                              (bubble.assistantMessage as string) ||
                              (bubble.text as string) || '';
      if (assistantContent) {
        messages.push({
          messageId: `${bubbleId}-assistant`,
          role: 'assistant',
          content: assistantContent,
          timestamp: bubble.responseTimestamp as number | undefined,
          model: bubble.model as string | undefined,
        });
      }
    }

    // Tool calls
    if (bubble.toolCalls && Array.isArray(bubble.toolCalls)) {
      for (let i = 0; i < bubble.toolCalls.length; i++) {
        const tool = bubble.toolCalls[i] as Record<string, unknown>;
        messages.push({
          messageId: `${bubbleId}-tool-${i}`,
          role: 'tool',
          content: tool.result as string || '',
          timestamp: tool.timestamp as number | undefined,
          toolCall: {
            name: (tool.name as string) || (tool.toolName as string) || 'unknown',
            args: tool.args as Record<string, unknown> | undefined,
            result: tool.result as string | undefined,
          },
        });
      }
    }

    // Code blocks / file changes
    if (bubble.codeBlocks && Array.isArray(bubble.codeBlocks)) {
      for (let i = 0; i < bubble.codeBlocks.length; i++) {
        const block = bubble.codeBlocks[i] as Record<string, unknown>;
        const content = `File: ${block.filePath || 'unknown'}\n\`\`\`${block.language || ''}\n${block.code || ''}\n\`\`\``;
        messages.push({
          messageId: `${bubbleId}-code-${i}`,
          role: 'assistant',
          content,
          timestamp: block.timestamp as number | undefined,
        });
      }
    }

    return messages;
  }

  /**
   * Get all composer sessions from the database
   */
  async getAllComposers(): Promise<ComposerData[]> {
    // Return cached data if valid
    if (this.isCacheValid()) {
      return this.cachedComposers!;
    }

    try {
      const db = await this.ensureOpen();

      const row = await this.queryGet<{ value: unknown }>(
        db,
        'SELECT value FROM ItemTable WHERE key = ?',
        ['composer.composerData']
      );

      if (!row || row.value === undefined) {
        this.cachedComposers = [];
        this.cacheTimestamp = Date.now();
        return [];
      }

      const composers = this.parseComposerValue(row.value);
      this.cachedComposers = composers;
      this.cacheTimestamp = Date.now();
      return composers;
    } catch (err) {
      console.error('[Deadhand] Error reading composer data:', err);
      // Return stale cache if available, otherwise empty
      return this.cachedComposers ?? [];
    }
  }

  /**
   * Get a specific composer by ID
   */
  async getComposerById(composerId: string): Promise<ComposerData | null> {
    const allComposers = await this.getAllComposers();
    return allComposers.find((c) => c.composerId === composerId) ?? null;
  }

  /**
   * Get the model name for a composer session from Cursor's global cursorDiskKV.
   * Returns null if unavailable.
   */
  async getComposerModelName(composerId: string): Promise<string | null> {
    try {
      const gdb = await this.ensureGlobalOpen();
      const row = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        [`composerData:${composerId}`]
      );
      if (!row?.value) return null;

      const jsonStr = this.decodeValue(row.value);
      if (!jsonStr) return null;

      const data = JSON.parse(jsonStr) as any;
      const modelName = data?.modelConfig?.modelName;
      return typeof modelName === 'string' ? modelName : null;
    } catch {
      return null;
    }
  }

  /**
   * Get model config (modelName + maxMode) for a composer session from Cursor's global cursorDiskKV.
   * Returns null fields if unavailable.
   */
  async getComposerModelConfig(
    composerId: string
  ): Promise<{ modelName: string | null; maxMode: boolean | null }> {
    try {
      const gdb = await this.ensureGlobalOpen();
      const row = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        [`composerData:${composerId}`]
      );
      if (!row?.value) return { modelName: null, maxMode: null };

      const jsonStr = this.decodeValue(row.value);
      if (!jsonStr) return { modelName: null, maxMode: null };

      const data = JSON.parse(jsonStr) as any;
      const modelName = data?.modelConfig?.modelName;
      const maxMode = data?.modelConfig?.maxMode;
      return {
        modelName: typeof modelName === 'string' ? modelName : null,
        maxMode: typeof maxMode === 'boolean' ? maxMode : null,
      };
    } catch {
      return { modelName: null, maxMode: null };
    }
  }

  /**
   * Get unifiedMode for a composer from Cursor's global cursorDiskKV composerData:<id>.
   */
  async getComposerUnifiedMode(composerId: string): Promise<string | null> {
    try {
      const gdb = await this.ensureGlobalOpen();
      const row = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        [`composerData:${composerId}`]
      );
      if (!row?.value) return null;
      const jsonStr = this.decodeValue(row.value);
      if (!jsonStr) return null;
      const data = JSON.parse(jsonStr) as any;
      const m = data?.unifiedMode;
      return typeof m === 'string' ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current draft prompt fields (text + richText) for a composer from global cursorDiskKV composerData:<id>.
   * These fields represent the input box state (what's typed but not necessarily submitted yet).
   */
  async getComposerDraft(composerId: string): Promise<{ text: string | null; richText: string | null }> {
    try {
      const gdb = await this.ensureGlobalOpen();
      const row = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        [`composerData:${composerId}`]
      );
      if (!row?.value) return { text: null, richText: null };
      const jsonStr = this.decodeValue(row.value);
      if (!jsonStr) return { text: null, richText: null };
      const data = JSON.parse(jsonStr) as any;
      const text = typeof data?.text === 'string' ? data.text : null;
      const richText = typeof data?.richText === 'string' ? data.richText : null;
      return { text, richText };
    } catch {
      return { text: null, richText: null };
    }
  }

  /**
   * Get Cursor's applicationUser reactive storage JSON (global state.vscdb ItemTable).
   * This contains availableDefaultModels2 and other UI settings.
   */
  async getApplicationUserState(): Promise<any | null> {
    try {
      const gdb = await this.ensureGlobalOpen();
      const row = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM ItemTable WHERE key = ?',
        ['src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser']
      );
      const raw = row?.value;
      if (!raw) return null;
      // In practice this is stored as plain JSON text.
      const jsonStr = typeof raw === 'string' ? raw : this.decodeValue(raw);
      if (!jsonStr) return null;
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * Returns models that are currently enabled/toggled on in the Cursor UI.
   * Source: applicationUser.availableDefaultModels2[].defaultOn === true
   */
  async getEnabledModels(): Promise<Array<{ name: string; clientDisplayName?: string; serverModelName?: string }>> {
    const app = await this.getApplicationUserState();
    const models = app?.availableDefaultModels2;
    if (!Array.isArray(models)) return [];
    return models
      .filter((m) => m && typeof m === 'object' && m.defaultOn === true && typeof m.name === 'string')
      .map((m) => ({
        name: String(m.name),
        clientDisplayName: typeof m.clientDisplayName === 'string' ? m.clientDisplayName : undefined,
        serverModelName: typeof m.serverModelName === 'string' ? m.serverModelName : undefined,
        supportsMaxMode: typeof m.supportsMaxMode === 'boolean' ? m.supportsMaxMode : undefined,
        supportsThinking: typeof m.supportsThinking === 'boolean' ? m.supportsThinking : undefined,
      }));
  }

  /**
   * Get conversation transcript for a composer session
   * @param composerId The composer session ID
   * @param incremental If true, bypass cache and only return new messages (for real-time updates)
   */
  async getConversationTranscript(composerId: string, incremental: boolean = false): Promise<ConversationTranscript> {
    // Check cache (skip if incremental mode)
    if (!incremental) {
      const cached = this.cachedTranscripts.get(composerId);
      if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
        return cached.data;
      }
    }

    const result: ConversationTranscript = {
      composerId,
      messages: [],
    };

    try {
      const db = await this.ensureOpen();

      // Check if we have a previously discovered key for this composer
      const discoveredEntry = discoveredKeyCache.get(composerId);
      if (discoveredEntry && Date.now() - discoveredEntry.timestamp < DISCOVERED_KEY_TTL) {
        const row = await this.queryGet<{ value: unknown }>(
          db,
          'SELECT value FROM ItemTable WHERE key = ?',
          [discoveredEntry.key]
        );
        if (row?.value) {
          const messages = this.parseConversationValue(composerId, row.value);
          if (messages.length > 0) {
            result.messages = messages;
            this.cachedTranscripts.set(composerId, { data: result, timestamp: Date.now() });
            return result;
          }
        }
        // Key no longer works, clear it
        discoveredKeyCache.delete(composerId);
      }

      // Expanded list of possible key patterns Cursor might use
      const possibleKeys = [
        // Composer-specific patterns
        `composer.conversation.${composerId}`,
        `composer.messages.${composerId}`,
        `composer.bubbles.${composerId}`,
        `composer.transcript.${composerId}`,
        `composer.history.${composerId}`,
        `composer.${composerId}`,
        `composer.${composerId}.conversation`,
        `composer.${composerId}.messages`,
        // AIChat patterns
        `aiChat.conversation.${composerId}`,
        `aiChat.messages.${composerId}`,
        `aiChat.${composerId}`,
        `aichat.conversation.${composerId}`,
        `aichat.messages.${composerId}`,
        // Chat patterns
        `chat.${composerId}`,
        `chat.conversation.${composerId}`,
        `chat.messages.${composerId}`,
        // Session patterns
        `session.${composerId}`,
        `session.${composerId}.conversation`,
        // Workbench patterns (VS Code style)
        `workbench.panel.chat.${composerId}`,
        `workbench.chat.${composerId}`,
      ];

      for (const key of possibleKeys) {
        const row = await this.queryGet<{ value: unknown }>(
          db,
          'SELECT value FROM ItemTable WHERE key = ?',
          [key]
        );

        if (row?.value) {
          const messages = this.parseConversationValue(composerId, row.value);
          if (messages.length > 0) {
            result.messages = messages;
            // Cache the successful key for future lookups
            discoveredKeyCache.set(composerId, { key, timestamp: Date.now() });
            console.log(`[Deadhand] Found transcript in key: ${key} (${messages.length} messages)`);
            break;
          }
        }
      }

      // If no specific conversation key found, try broader pattern matching
      if (result.messages.length === 0) {
        // First try keys containing the composerId
        const rows = await this.queryAll<{ key: string; value: unknown }>(
          db,
          'SELECT key, value FROM ItemTable WHERE key LIKE ?',
          [`%${composerId}%`]
        );

        for (const row of rows) {
          // Skip the composerData entry and other metadata
          if (row.key === 'composer.composerData') continue;
          if (row.key.endsWith('.metadata')) continue;
          if (row.key.endsWith('.settings')) continue;
          
          const messages = this.parseConversationValue(composerId, row.value);
          if (messages.length > 0) {
            result.messages = messages;
            discoveredKeyCache.set(composerId, { key: row.key, timestamp: Date.now() });
            console.log(`[Deadhand] Found transcript via pattern match: ${row.key} (${messages.length} messages)`);
            break;
          }
        }
      }

      // If still no results, try discovering keys that might contain conversation data
      if (result.messages.length === 0) {
        const conversationKeys = await this.discoverConversationKeys(db, composerId);
        for (const keyInfo of conversationKeys) {
          const messages = this.parseConversationValue(composerId, keyInfo.value);
          if (messages.length > 0) {
            result.messages = messages;
            discoveredKeyCache.set(composerId, { key: keyInfo.key, timestamp: Date.now() });
            console.log(`[Deadhand] Found transcript via discovery: ${keyInfo.key} (${messages.length} messages)`);
            break;
          }
        }
      }

      // Fallback: Cursor stores composer chat bubbles in GLOBAL state.vscdb cursorDiskKV
      if (result.messages.length === 0) {
        const kvMessages = await this.loadTranscriptFromGlobalCursorDiskKV(composerId, incremental);
        if (kvMessages.length > 0) {
          result.messages = kvMessages;
          console.log(`[Deadhand] Loaded transcript from global cursorDiskKV (${kvMessages.length} messages${incremental ? ' incremental' : ''})`);
        }
      }

      // Cache the result (even if empty, to avoid repeated lookups) - but not for incremental reads
      if (!incremental) {
        this.cachedTranscripts.set(composerId, {
          data: result,
          timestamp: Date.now(),
        });
      }

      if (result.messages.length === 0 && !incremental) {
        console.log(`[Deadhand] No transcript found for composer: ${composerId}`);
      }

      return result;
    } catch (err) {
      console.error('[Deadhand] Error reading conversation transcript:', err);
      return result;
    }
  }

  /**
   * Load transcript messages from Cursor's global cursorDiskKV store.
   *
   * Cursor persists per-composer bubble records under:
   * - composerData:<composerId>  (includes fullConversationHeadersOnly)
   * - bubbleId:<composerId>:<bubbleId> (individual bubble objects)
   * 
   * @param composerId The composer session ID
   * @param incremental If true, only return bubbles not seen before (session-scoped optimization)
   */
  private async loadTranscriptFromGlobalCursorDiskKV(composerId: string, incremental: boolean = false): Promise<ConversationMessage[]> {
    try {
      const gdb = await this.ensureGlobalOpen();

      const composerRow = await this.queryGet<{ value: unknown }>(
        gdb,
        'SELECT value FROM cursorDiskKV WHERE key = ?',
        [`composerData:${composerId}`]
      );

      if (!composerRow?.value) {
        // Best-effort: check if the data exists in the WORKSPACE state.vscdb cursorDiskKV instead
        // (Cursor storage layout can vary by version/session type).
        let workspaceComposerDataExists: boolean | null = null;
        let globalAnyBubbleKeyExists: boolean | null = null;
        let workspaceAnyBubbleKeyExists: boolean | null = null;
        try {
          const anyBubble = await this.queryGet<{ key: string }>(
            gdb,
            'SELECT key FROM cursorDiskKV WHERE key LIKE ? LIMIT 1',
            [`bubbleId:${composerId}:%`]
          );
          globalAnyBubbleKeyExists = !!anyBubble?.key;
        } catch {
          globalAnyBubbleKeyExists = null;
        }
        try {
          const wdb = await this.ensureOpen();
          const wRow = await this.queryGet<{ value: unknown }>(
            wdb,
            'SELECT value FROM cursorDiskKV WHERE key = ?',
            [`composerData:${composerId}`]
          );
          workspaceComposerDataExists = !!wRow?.value;
          try {
            const anyBubble = await this.queryGet<{ key: string }>(
              wdb,
              'SELECT key FROM cursorDiskKV WHERE key LIKE ? LIMIT 1',
              [`bubbleId:${composerId}:%`]
            );
            workspaceAnyBubbleKeyExists = !!anyBubble?.key;
          } catch {
            workspaceAnyBubbleKeyExists = null;
          }
        } catch {
          workspaceComposerDataExists = null;
          workspaceAnyBubbleKeyExists = null;
        }

        // If composerData:<id> is missing but we have bubbleId:<id>:* keys, fall back to scanning bubbles.
        if (globalAnyBubbleKeyExists === true) {
          try {
            const bubbleOnly = await this.loadTranscriptFromGlobalBubblesOnly(composerId, incremental);
            if (bubbleOnly.length > 0) {
              return bubbleOnly;
            }
          } catch {
            // ignore and fall through to returning empty
          }
        }
        return [];
      }

      const composerJson = this.decodeValue(composerRow.value);
      if (!composerJson) return [];

      let composerData: any;
      try {
        composerData = JSON.parse(composerJson);
      } catch {
        return [];
      }

      const headers: Array<{ bubbleId?: string; type?: number }> =
        Array.isArray(composerData?.fullConversationHeadersOnly) ? composerData.fullConversationHeadersOnly : [];

      if (headers.length === 0) {
        return [];
      }

      const out: ConversationMessage[] = [];
      const seenSet = this.seenBubbleIds.get(composerId) || new Set<string>();

      const defaultModelName =
        typeof composerData?.modelConfig?.modelName === 'string'
          ? composerData.modelConfig.modelName
          : undefined;

      for (let i = 0; i < headers.length; i++) {
        const bubbleId = headers[i]?.bubbleId;
        const bubbleType = headers[i]?.type;
        if (typeof bubbleId !== 'string' || bubbleId.length < 8) continue;

        // Skip if incremental mode and we've seen this bubble
        if (incremental && seenSet.has(bubbleId)) {
          continue;
        }

        const bubbleRow = await this.queryGet<{ value: unknown }>(
          gdb,
          'SELECT value FROM cursorDiskKV WHERE key = ?',
          [`bubbleId:${composerId}:${bubbleId}`]
        );

        if (!bubbleRow?.value) continue;

        const bubbleJson = this.decodeValue(bubbleRow.value);
        if (!bubbleJson) continue;

        let bubble: any;
        try {
          bubble = JSON.parse(bubbleJson);
        } catch {
          continue;
        }

        const createdAt = typeof bubble?.createdAt === 'string' ? Date.parse(bubble.createdAt) : undefined;
        const modelName =
          typeof bubble?.modelInfo?.modelName === 'string'
            ? bubble.modelInfo.modelName
            : typeof bubble?.modelInfo?.model === 'string'
              ? bubble.modelInfo.model
              : defaultModelName;

        // Tool bubble (Cursor stores ask_question and other tool invocations here)
        const toolFormer = bubble?.toolFormerData;
        if (toolFormer && typeof toolFormer.name === 'string') {
          let parsedArgs: Record<string, unknown> | undefined;
          const rawArgs = toolFormer.rawArgs;
          if (typeof rawArgs === 'string' && rawArgs.trim()) {
            try {
              parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              parsedArgs = { raw: rawArgs };
            }
          }

          const toolResult =
            typeof toolFormer.result === 'string'
              ? toolFormer.result
              : typeof toolFormer.output === 'string'
                ? toolFormer.output
                : undefined;

        const message: ConversationMessage = {
          messageId: bubbleId,
          role: 'tool',
          content: '', // tools may not have textual content
          timestamp: Number.isFinite(createdAt) ? createdAt : undefined,
          model: modelName,
          toolCall: {
            name: toolFormer.name,
            args: parsedArgs,
            result: toolResult,
          },
        };
        out.push(message);
        // Track seen bubbleId
        seenSet.add(bubbleId);
        continue;
        }

        // Cursor bubble objects appear to store content in `text` (and sometimes `richText`)
        const text =
          typeof bubble?.text === 'string'
            ? bubble.text
            : typeof bubble?.richText === 'string'
              ? bubble.richText
              : '';

        // Skip empty bubbles (after toolFormer handling)
        if (!text || typeof text !== 'string' || text.trim().length === 0) continue;

        // Heuristic mapping: header `type` 1=user, 2=assistant (observed in Cursor storage)
        const role: ConversationMessage['role'] = bubbleType === 1 ? 'user' : 'assistant';

        const message: ConversationMessage = {
          messageId: bubbleId,
          role,
          content: text,
          timestamp: Number.isFinite(createdAt) ? createdAt : undefined,
          model: modelName,
        };
        out.push(message);
        // Track seen bubbleId
        seenSet.add(bubbleId);
      }

      // Prefer ordering by timestamp when present, otherwise keep header order
      const hasAnyTs = out.some((m) => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp));
      if (hasAnyTs) {
        out.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      }

      // Update seen bubbleIds set
      if (seenSet.size > 0) {
        this.seenBubbleIds.set(composerId, seenSet);
      }

      return out;
    } catch {
      return [];
    }
  }

  /**
   * Discover keys that might contain conversation data
   * This is a bounded search to find new key patterns
   */
  private async discoverConversationKeys(
    db: Database,
    composerId: string
  ): Promise<Array<{ key: string; value: unknown }>> {
    const results: Array<{ key: string; value: unknown }> = [];

    // Search for keys with conversation-related patterns
    const patterns = [
      '%conversation%',
      '%messages%',
      '%bubbles%',
      '%transcript%',
      '%chat%',
      'composer.%',
      'aiChat.%',
      'aichat.%',
    ];

    const seenKeys = new Set<string>();

    for (const pattern of patterns) {
      const rows = await this.queryAll<{ key: string; value: unknown }>(
        db,
        'SELECT key, value FROM ItemTable WHERE key LIKE ? LIMIT 50',
        [pattern]
      );

      for (const row of rows) {
        // Skip if we've already processed this key
        if (seenKeys.has(row.key)) continue;
        seenKeys.add(row.key);

        // Skip metadata/settings keys
        if (row.key.endsWith('.metadata')) continue;
        if (row.key.endsWith('.settings')) continue;
        if (row.key === 'composer.composerData') continue;

        // Check if the value contains this composerId or looks like conversation data
        const decoded = this.decodeValue(row.value);
        if (decoded) {
          // Check if value contains the composerId or looks like messages
          if (decoded.includes(composerId) || 
              decoded.includes('"role"') || 
              decoded.includes('"content"') ||
              decoded.includes('"messages"') ||
              decoded.includes('"conversation"') ||
              decoded.includes('"bubbles"')) {
            results.push(row);
          }
        }

        // Limit results to avoid performance issues
        if (results.length >= 10) break;
      }

      if (results.length >= 10) break;
    }

    return results;
  }

  /**
   * List all ItemTable keys (for debugging/discovery)
   */
  async listAllKeys(): Promise<string[]> {
    try {
      const db = await this.ensureOpen();
      const rows = await this.queryAll<{ key: string }>(
        db,
        'SELECT key FROM ItemTable',
        []
      );
      return rows.map((r) => r.key);
    } catch (err) {
      console.error('[Deadhand] Error listing keys:', err);
      return [];
    }
  }

  /**
   * Get raw value for a key (for debugging)
   */
  async getRawValue(key: string): Promise<unknown> {
    try {
      const db = await this.ensureOpen();
      const row = await this.queryGet<{ value: unknown }>(
        db,
        'SELECT value FROM ItemTable WHERE key = ?',
        [key]
      );
      if (row?.value) {
        const decoded = this.decodeValue(row.value);
        if (decoded) {
          try {
            return JSON.parse(decoded);
          } catch {
            return decoded;
          }
        }
      }
      return row?.value;
    } catch (err) {
      console.error('[Deadhand] Error reading raw value:', err);
      return null;
    }
  }

  /**
   * Diagnose transcript storage for a composerId
   * Returns info about which keys were checked and what was found (without content)
   */
  async diagnoseTranscriptStorage(composerId: string): Promise<{
    dbPath: string | null;
    dbOpen: boolean;
    keysChecked: Array<{ key: string; found: boolean; valueType: string; messageCount: number }>;
    discoveredKeys: string[];
    cachedKey: string | null;
  }> {
    const result = {
      dbPath: this.getStateDbPath(),
      dbOpen: this.db !== null,
      keysChecked: [] as Array<{ key: string; found: boolean; valueType: string; messageCount: number }>,
      discoveredKeys: [] as string[],
      cachedKey: discoveredKeyCache.get(composerId)?.key ?? null,
    };

    try {
      const db = await this.ensureOpen();
      result.dbOpen = true;

      // Check common key patterns
      const keysToCheck = [
        `composer.conversation.${composerId}`,
        `composer.messages.${composerId}`,
        `composer.${composerId}`,
        `aiChat.conversation.${composerId}`,
        `chat.${composerId}`,
      ];

      for (const key of keysToCheck) {
        const row = await this.queryGet<{ value: unknown }>(
          db,
          'SELECT value FROM ItemTable WHERE key = ?',
          [key]
        );

        const entry = {
          key,
          found: row?.value !== undefined,
          valueType: 'none',
          messageCount: 0,
        };

        if (row?.value) {
          if (Buffer.isBuffer(row.value)) {
            entry.valueType = `Buffer(${row.value.length})`;
            // Check compression
            if (row.value.length >= 2) {
              if (row.value[0] === 0x1f && row.value[1] === 0x8b) {
                entry.valueType += ' [gzip]';
              } else if (row.value[0] === 0x78) {
                entry.valueType += ' [zlib?]';
              }
            }
          } else if (typeof row.value === 'string') {
            entry.valueType = `string(${row.value.length})`;
          } else {
            entry.valueType = typeof row.value;
          }

          const messages = this.parseConversationValue(composerId, row.value);
          entry.messageCount = messages.length;
        }

        result.keysChecked.push(entry);
      }

      // Find keys containing the composerId
      const matchingRows = await this.queryAll<{ key: string }>(
        db,
        'SELECT key FROM ItemTable WHERE key LIKE ?',
        [`%${composerId}%`]
      );
      result.discoveredKeys = matchingRows.map(r => r.key);

    } catch (err) {
      console.error('[Deadhand] Diagnosis error:', err);
    }

    return result;
  }

  /**
   * Close the database connection and clean up
   */
  async dispose(): Promise<void> {
    // Stop file watching
    this.stopWatching();

    const closeOne = (db: Database, label: string) =>
      new Promise<void>((resolve) => {
        db.close((err) => {
          if (err) {
            console.error(`[Deadhand] Error closing ${label} database:`, err);
          } else {
            console.log(`[Deadhand] ${label} SQLite database closed`);
          }
          resolve();
        });
      });

    if (this.db) {
      await closeOne(this.db, 'workspace');
      this.db = null;
    }

    if (this.globalDb) {
      await closeOne(this.globalDb, 'global');
      this.globalDb = null;
    }

    this.cachedComposers = null;
    this.cacheTimestamp = 0;
    this.cachedTranscripts.clear();
    
    // Clear seen bubbleIds (session-scoped optimization cleared on dispose)
    this.seenBubbleIds.clear();
    
    // Clear callbacks
    this.transcriptChangeCallbacks.clear();
  }

  /**
   * Invalidate the cache (useful after detecting external changes)
   */
  invalidateCache(): void {
    this.cachedComposers = null;
    this.cacheTimestamp = 0;
    this.cachedTranscripts.clear();
  }

  /**
   * Clear seen bubbleIds for a composer (used on resync/reconnect)
   * This ensures we backfill all messages, not just new ones
   */
  clearSeenBubbleIds(composerId?: string): void {
    if (composerId) {
      this.seenBubbleIds.delete(composerId);
    } else {
      // Clear all
      this.seenBubbleIds.clear();
    }
  }

  /**
   * Get incremental transcript changes for a composer (only new bubbles)
   */
  async getIncrementalTranscript(composerId: string): Promise<ConversationTranscript> {
    return this.getConversationTranscript(composerId, true);
  }
}

/**
 * Convert Cursor's unifiedMode to our SessionMode type
 */
export function toSessionMode(unifiedMode?: string): SessionMode {
  switch (unifiedMode) {
    case 'agent':
      return 'agent';
    case 'chat':
      return 'chat';
    case 'plan':
      return 'plan';
    case 'debug':
      return 'debug';
    case 'background':
      return 'background';
    default:
      return 'unknown';
  }
}

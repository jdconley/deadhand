import * as vscode from 'vscode';
import { watch, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DaemonClient } from '../daemon-client';
import type { CursorAdapter } from '../cursor-adapter';
import type { Session, TranscriptEvent } from '../types';
import { nanoid } from 'nanoid';

/**
 * CursorLogsAdapter
 * 
 * Reverse-engineered adapter that watches Cursor's log files and internal
 * storage to extract agent activity. This is a fallback when official APIs
 * are not available.
 * 
 * IMPORTANT: This adapter depends on Cursor's internal file structure and
 * may break with Cursor updates. Use with caution.
 */

interface LogsAdapterConfig {
  enabled: boolean;
  logPaths: string[];
  storagePaths: string[];
}

function getDefaultConfig(): LogsAdapterConfig {
  const platform = process.platform;
  let appDataPath: string;

  switch (platform) {
    case 'darwin':
      appDataPath = join(homedir(), 'Library', 'Application Support', 'Cursor');
      break;
    case 'win32':
      appDataPath = join(process.env.APPDATA || '', 'Cursor');
      break;
    default: // Linux and others
      appDataPath = join(homedir(), '.config', 'Cursor');
      break;
  }

  return {
    enabled: false, // Disabled by default - requires explicit opt-in
    logPaths: [
      join(appDataPath, 'logs'),
      join(appDataPath, 'exthost'),
    ],
    storagePaths: [
      join(appDataPath, 'User', 'workspaceStorage'),
      join(appDataPath, 'User', 'globalStorage'),
    ],
  };
}

export function createLogsAdapter(client: DaemonClient): CursorAdapter | null {
  const config = getDefaultConfig();
  const watchers: ReturnType<typeof watch>[] = [];
  let currentSession: { id: string; title: string } | null = null;
  let enabled = false;

  // Check if logs adapter is enabled via settings
  const settings = vscode.workspace.getConfiguration('deadhand');
  enabled = settings.get('enableLogsAdapter', false);

  if (!enabled) {
    console.log('[Deadhand] Logs adapter disabled (set deadhand.enableLogsAdapter to enable)');
    return null;
  }

  function startSession(title: string) {
    if (currentSession) {
      endCurrentSession();
    }
    
    currentSession = {
      id: nanoid(),
      title,
    };
    
    const session: Omit<Session, 'instanceId'> = {
      sessionId: currentSession.id,
      title,
      status: 'active',
    };
    
    client.startSession(session);
  }

  function endCurrentSession() {
    if (currentSession) {
      client.endSession(currentSession.id);
      currentSession = null;
    }
  }

  function sendEvent(type: TranscriptEvent['type'], payload: Record<string, unknown>) {
    if (!currentSession) {
      startSession('Agent Session (Logs)');
    }
    
    const event: TranscriptEvent = {
      sessionId: currentSession!.id,
      type,
      payload,
    };
    
    client.sendTranscriptEvent(event);
  }

  /**
   * Parse log line for agent activity
   * This is highly dependent on Cursor's log format and may need updates
   */
  function parseLogLine(line: string): { type: TranscriptEvent['type']; payload: Record<string, unknown> } | null {
    // Example patterns (these are hypothetical and need to be discovered)
    
    // Look for AI/agent related keywords
    const aiPatterns = [
      /\[AI\]\s*(.+)/i,
      /\[Agent\]\s*(.+)/i,
      /\[Chat\]\s*(.+)/i,
      /\[Composer\]\s*(.+)/i,
      /claude|gpt|anthropic|openai/i,
    ];

    for (const pattern of aiPatterns) {
      const match = line.match(pattern);
      if (match) {
        return {
          type: 'message',
          payload: {
            raw: line,
            content: match[1] || line,
          },
        };
      }
    }

    // Look for tool invocations
    const toolPatterns = [
      /executing\s+tool:\s*(\w+)/i,
      /running\s+command:\s*(.+)/i,
      /file\s+(?:read|write|create|delete):\s*(.+)/i,
    ];

    for (const pattern of toolPatterns) {
      const match = line.match(pattern);
      if (match) {
        return {
          type: 'tool_start',
          payload: {
            tool: match[1],
            raw: line,
          },
        };
      }
    }

    return null;
  }

  /**
   * Watch a log file for changes
   */
  function watchLogFile(filePath: string) {
    if (!existsSync(filePath)) {
      return;
    }

    let lastSize = 0;
    try {
      const stats = require('fs').statSync(filePath);
      lastSize = stats.size;
    } catch {
      return;
    }

    const watcher = watch(filePath, (eventType) => {
      if (eventType === 'change') {
        try {
          const stats = require('fs').statSync(filePath);
          if (stats.size > lastSize) {
            // Read new content
            const fd = require('fs').openSync(filePath, 'r');
            const buffer = Buffer.alloc(stats.size - lastSize);
            require('fs').readSync(fd, buffer, 0, buffer.length, lastSize);
            require('fs').closeSync(fd);

            const newContent = buffer.toString('utf-8');
            const lines = newContent.split('\n').filter((l: string) => l.trim());

            for (const line of lines) {
              const parsed = parseLogLine(line);
              if (parsed) {
                sendEvent(parsed.type, parsed.payload);
              }
            }

            lastSize = stats.size;
          }
        } catch (err) {
          console.error('[Deadhand] Error reading log file:', err);
        }
      }
    });

    watchers.push(watcher);
  }

  /**
   * Watch a directory for new log files
   */
  function watchLogDirectory(dirPath: string) {
    if (!existsSync(dirPath)) {
      return;
    }

    const watcher = watch(dirPath, (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        const filePath = join(dirPath, filename);
        if (existsSync(filePath) && filename.endsWith('.log')) {
          watchLogFile(filePath);
        }
      }
    });

    watchers.push(watcher);

    // Watch existing log files
    try {
      const files = require('fs').readdirSync(dirPath);
      for (const file of files) {
        if (file.endsWith('.log')) {
          watchLogFile(join(dirPath, file));
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return {
    start() {
      console.log('[Deadhand] Starting logs adapter...');
      console.log('[Deadhand] WARNING: This adapter reads Cursor internal files and may break with updates');

      // Watch log directories
      for (const logPath of config.logPaths) {
        watchLogDirectory(logPath);
      }

      // Watch storage for potential state files
      for (const _storagePath of config.storagePaths) {
        // TODO: Implement storage watching for agent state
      }

      console.log('[Deadhand] Logs adapter started');
    },

    stop() {
      endCurrentSession();
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers.length = 0;
      console.log('[Deadhand] Logs adapter stopped');
    },

    resync() {
      // For logs adapter, just re-register current session if we have one
      if (currentSession) {
        const session: Omit<Session, 'instanceId'> = {
          sessionId: currentSession.id,
          title: currentSession.title,
          status: 'active',
        };
        client.startSession(session);
      }
    },
  };
}

/**
 * Get Cursor data directories for the current platform
 */
export function getCursorPaths(): { appData: string; logs: string; storage: string } {
  const platform = process.platform;
  let appData: string;

  switch (platform) {
    case 'darwin':
      appData = join(homedir(), 'Library', 'Application Support', 'Cursor');
      break;
    case 'win32':
      appData = join(process.env.APPDATA || '', 'Cursor');
      break;
    default:
      appData = join(homedir(), '.config', 'Cursor');
      break;
  }

  return {
    appData,
    logs: join(appData, 'logs'),
    storage: join(appData, 'User', 'globalStorage'),
  };
}


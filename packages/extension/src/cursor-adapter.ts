import * as vscode from 'vscode';
import type { DaemonClient } from './daemon-client';
import { createOfficialAdapter as createOfficial } from './adapters/official';
import { createLogsAdapter as createLogs } from './adapters/logs';

/**
 * Adapter interface for extracting agent/session data from Cursor
 */
export interface CursorAdapter {
  start(): void;
  stop(): void;
  /** Called when daemon connection is re-established to resync all data */
  resync(): void;
}

/**
 * Create the appropriate adapter based on available APIs
 * 
 * This is a pluggable architecture that tries official APIs first,
 * then falls back to reverse-engineered approaches.
 * 
 * Priority:
 * 1. Official Cursor/VS Code APIs (if available)
 * 2. Logs adapter (if enabled and working)
 */
export function createCursorAdapter(client: DaemonClient, context: vscode.ExtensionContext): CursorAdapter {
  // Try official adapter first - uses composer.getOrderedSelectedComposerIds polling
  // and reads rich metadata from Cursor's SQLite storage
  const officialAdapter = createOfficial(client, context);
  if (officialAdapter) {
    console.log('[Deadhand] Using official Cursor adapter with composer polling and SQLite enrichment');
    return officialAdapter;
  }
  
  // Try logs adapter as fallback
  const logsAdapter = createLogs(client);
  if (logsAdapter) {
    console.log('[Deadhand] Using logs adapter (fallback)');
    return logsAdapter;
  }
  
  // No adapter available - show error
  console.error('[Deadhand] No working adapter found');
  vscode.window.showErrorMessage(
    'Deadhand: Could not access Cursor agent data. ' +
    'Set deadhand.enableLogsAdapter to true to try log file parsing.'
  );
  
  // Return a no-op adapter
  return {
    start() {
      console.log('[Deadhand] No-op adapter started (no data source available)');
    },
    stop() {
      console.log('[Deadhand] No-op adapter stopped');
    },
    resync() {
      // Nothing to resync
    },
  };
}

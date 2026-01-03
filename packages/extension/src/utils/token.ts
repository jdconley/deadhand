import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as vscode from 'vscode';

const TOKEN_FILENAME = 'access_token';

/**
 * Get the daemon data directory
 */
export function getDaemonDataDir(): string {
  const config = vscode.workspace.getConfiguration('deadhand');
  const customDir = config.get<string>('daemonDataDir');
  
  if (customDir && customDir.trim()) {
    return customDir.trim();
  }
  
  return join(homedir(), '.deadhand');
}

/**
 * Read the access token from the daemon data directory
 */
export function readToken(): string | null {
  const dataDir = getDaemonDataDir();
  const tokenPath = join(dataDir, TOKEN_FILENAME);
  
  if (!existsSync(tokenPath)) {
    return null;
  }
  
  try {
    return readFileSync(tokenPath, 'utf-8').trim();
  } catch (err) {
    console.error('[Deadhand] Failed to read token:', err);
    return null;
  }
}

/**
 * Mask a token for display (show first 4 and last 4 characters)
 */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '••••••••';
  }
  return `${token.slice(0, 4)}${'•'.repeat(Math.min(token.length - 8, 20))}${token.slice(-4)}`;
}


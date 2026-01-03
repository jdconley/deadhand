import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { getConfig } from './config';
import { probeDaemon } from './utils/daemonProbe';

let daemonProcess: ChildProcess | null = null;

/**
 * Check if daemon is running by probing both HTTP and HTTPS
 */
export async function isDaemonRunning(): Promise<boolean> {
  const daemonInfo = await probeDaemon();
  return daemonInfo.reachable;
}

/**
 * Start the daemon if not already running
 */
export async function ensureDaemonRunning(context: vscode.ExtensionContext): Promise<boolean> {
  const config = getConfig();

  // Check if already running
  if (await isDaemonRunning()) {
    console.log('[Deadhand] Daemon already running');
    return true;
  }

  if (!config.autoStartDaemon) {
    console.log('[Deadhand] Auto-start disabled, daemon not running');
    return false;
  }

  // Try to find and start the daemon
  const daemonPath = findDaemonExecutable(context);
  if (!daemonPath) {
    vscode.window.showWarningMessage(
      'Deadhand: Could not find daemon. Please run it manually or install the daemon package.'
    );
    return false;
  }

  console.log('[Deadhand] Starting daemon from:', daemonPath);

  try {
    // Set environment for localhost-only mode when auto-starting
    // (this is safer for auto-start; LAN mode should be explicit)
    const env = {
      ...process.env,
      DEADHAND_PORT: String(config.daemonPort),
      DEADHAND_LOCALHOST_ONLY: 'true',
    };

    daemonProcess = spawn('node', [daemonPath], {
      env,
      detached: true,
      stdio: 'ignore',
    });

    daemonProcess.unref();

    // Wait a bit for daemon to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (await isDaemonRunning()) {
      console.log('[Deadhand] Daemon started successfully');
      return true;
    }

    console.error('[Deadhand] Daemon failed to start');
    return false;
  } catch (err) {
    console.error('[Deadhand] Failed to start daemon:', err);
    return false;
  }
}

/**
 * Find the daemon executable path
 */
function findDaemonExecutable(context: vscode.ExtensionContext): string | null {
  // Check common locations
  const possiblePaths = [
    // Bundled with extension
    join(context.extensionPath, 'node_modules', '@deadhand', 'daemon', 'dist', 'index.js'),
    // Monorepo development
    join(context.extensionPath, '..', 'daemon', 'dist', 'index.js'),
    // Global install
    // This would need to be detected differently
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Stop the daemon if we started it
 */
export function stopDaemon(): void {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
    console.log('[Deadhand] Daemon stopped');
  }
}


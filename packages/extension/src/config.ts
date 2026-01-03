import * as vscode from 'vscode';

export interface ExtensionConfig {
  daemonPort: number;
  autoStartDaemon: boolean;
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('deadhand');
  return {
    daemonPort: config.get('daemonPort', 31337),
    autoStartDaemon: config.get('autoStartDaemon', true),
  };
}


import * as vscode from 'vscode';
import { createDaemonClient, type DaemonClient } from './daemon-client';
import { ensureDaemonRunning, isDaemonRunning } from './daemon-launcher';
import { createCursorAdapter, type CursorAdapter } from './cursor-adapter';
import { getConfig } from './config';
import { PairingViewProvider } from './views/pairingView';
import { readToken } from './utils/token';
import { probeDaemon, buildWebUrl } from './utils/daemonProbe';
import { registerDebugCommands, generateDebugReport } from './debug';
import { platform } from 'os';
import { createHash } from 'crypto';
import { CursorComposerStorageReader } from './storage-reader';

let client: DaemonClient | null = null;
let adapter: CursorAdapter | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let pairingViewProvider: PairingViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Deadhand] Extension activating...');

  // Create and register the pairing view
  pairingViewProvider = new PairingViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PairingViewProvider.viewType,
      pairingViewProvider
    )
  );

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(broadcast) Deadhand';
  statusBarItem.tooltip = 'Deadhand: Click to show pairing';
  statusBarItem.command = 'deadhand.showPairing';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('deadhand.showStatus', showStatus),
    vscode.commands.registerCommand('deadhand.openWebUI', openWebUI),
    vscode.commands.registerCommand('deadhand.rotateToken', rotateToken),
    vscode.commands.registerCommand('deadhand.showPairing', showPairing),
    vscode.commands.registerCommand('deadhand.copyToken', copyToken),
    vscode.commands.registerCommand('deadhand.copyWebUrl', copyWebUrl),
    vscode.commands.registerCommand('deadhand.refreshPairing', refreshPairing)
  );

  // Register debug commands
  registerDebugCommands(context);

  // Generate initial debug report on activation (in debug mode)
  const config = vscode.workspace.getConfiguration('deadhand');
  if (config.get('debugMode', false)) {
    generateDebugReport().catch(console.error);
  }

  // Start connection
  await connectToDaemon(context);
}

async function connectToDaemon(context: vscode.ExtensionContext) {
  // Ensure daemon is running
  const running = await ensureDaemonRunning(context);
  if (!running) {
    updateStatusBar('error', 'Daemon not running');
    return;
  }

  // Create and connect client with reconnect handling
  client = createDaemonClient({
    onConnect: () => {
      updateStatusBar('connected', 'Connected to daemon');
      
      // Resync adapter state when reconnected
      if (adapter) {
        console.log('[Deadhand] Connection established, triggering resync...');
        adapter.resync();
      }
    },
    onDisconnect: () => {
      updateStatusBar('disconnected', 'Reconnecting...');
    },
    onSendMessageRequest: async (sessionId, message, requestId) => {
      console.log(`[Deadhand] Received remote send_message request for session ${sessionId.slice(0, 8)}...`);
      
      const msgHash = createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 12);
      
      // Read transcript BEFORE attempting any action so we can verify real delivery.
      const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      let beforeCount = 0;
      let beforeLastRole: string | null = null;
      let beforeLastHash: string | null = null;
      try {
        const before = await storageReader.getConversationTranscript(sessionId);
        beforeCount = before.messages.length;
        const last = before.messages[before.messages.length - 1];
        beforeLastRole = last?.role ?? null;
        if (last?.content) {
          beforeLastHash = createHash('sha256').update(String(last.content), 'utf8').digest('hex').slice(0, 12);
        }
      } catch {
        // ignore (best-effort)
      }

      // Try to send the message using available methods
      try {
        // Discover command availability once up-front (helps us select the safest strategy).
        let allCommands: string[] = [];
        try {
          allCommands = await vscode.commands.getCommands(true);
        } catch {
          allCommands = [];
        }

        const hasOpenComposer = allCommands.includes('composer.openComposer');
        const hasTriggerSubmit = allCommands.includes('composer.triggerCreateWorktreeButton');
        const hasGetOrdered = allCommands.includes('composer.getOrderedSelectedComposerIds');
        const hasWorkbenchChatSubmit = allCommands.includes('workbench.action.chat.submit');
        const hasChatFocusInput = allCommands.includes('workbench.action.chat.focusInput');
        const hasTypeCommand = allCommands.includes('type');

        const sendCommandSamples = allCommands
          .filter(
            (c) =>
              c.includes('composer.') &&
              (c.includes('submit') || c.includes('input') || c.includes('text') || c.includes('focus'))
          )
          .slice(0, 60);

        const verifyDelivered = async (timeoutMs: number) => {
          const start = Date.now();
          let afterCount = beforeCount;
          let afterLastRole: string | null = null;
          let afterLastHash: string | null = null;
          let delivered = false;
          while (!delivered && Date.now() - start < timeoutMs) {
            try {
              const after = await storageReader.getConversationTranscript(sessionId);
              afterCount = after.messages.length;
              const last = after.messages[after.messages.length - 1];
              afterLastRole = last?.role ?? null;
              if (last?.content) {
                afterLastHash = createHash('sha256').update(String(last.content), 'utf8').digest('hex').slice(0, 12);
              }
              const newMessages = after.messages.slice(Math.max(0, beforeCount));
              delivered =
                afterCount > beforeCount &&
                newMessages.some(
                  (m) =>
                    m.role === 'user' &&
                    createHash('sha256').update(String(m.content), 'utf8').digest('hex').slice(0, 12) === msgHash
                );
              if (delivered) break;
            } catch {
              // ignore
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          return { delivered, afterCount, afterLastRole, afterLastHashPrefix: afterLastHash };
        };

        // Strategy 1: Use unified chat submit API (Cursor uses VS Code's chat widget internally).
        // This avoids UI automation and avoids typing into the editor.
        let cmdOpenOk = false;
        let cmdSubmitOk = false;
        let cmdSubmitError: string | null = null;
        let submitCommandSamples: string[] | null = null;
        try {
          if (hasOpenComposer) {
            await vscode.commands.executeCommand('composer.openComposer', sessionId, {
              focusMainInputBox: true,
              insertSelection: false,
            });
            cmdOpenOk = true;
          } else {
            cmdOpenOk = false;
          }
        } catch {
          cmdOpenOk = false;
        }
        try {
          // Discover command availability (best-effort, helps debug "command not found" vs runtime failure)
          try {
            submitCommandSamples = allCommands
              .filter((c) => c.includes('chat.submit') || c.includes('composer.quickAgentSubmit'))
              .slice(0, 25);
          } catch {
            submitCommandSamples = null;
          }
          // workbench.action.chat.submit accepts an optional arg object:
          // { inputValue?: string, widget?: unknown }
          if (hasWorkbenchChatSubmit) {
            await vscode.commands.executeCommand('workbench.action.chat.submit', {
              inputValue: message,
            });
            cmdSubmitOk = true;
          } else {
            cmdSubmitOk = false;
            cmdSubmitError = "Command 'workbench.action.chat.submit' not found";
          }
        } catch (err) {
          cmdSubmitOk = false;
          cmdSubmitError = String(err);
        }

        // Verify AFTER command strategy (poll briefly to avoid false negatives).
        const cmdVerify = await verifyDelivered(5000);
        const cmdDelivered = cmdVerify.delivered;

        if (cmdDelivered) {
          console.log(`[Deadhand] Message delivered via command strategy (verified in transcript)`);
          return { success: true };
        }

        // Cursor's composer input is a webview, not a text editor. The VS Code `type` command writes to the active text editor,
        // so "in-place send" is not reliable in this build (it ends up typing into an untitled editor).
        //
        // Fallback: create a NEW composer prefilled with a continuation prompt that includes a small slice of the prior transcript,
        // then submit that. The Web UI will navigate to the new composerId for "continue conversation" semantics.
        if (!allCommands.includes('composer.createNew') || !hasTriggerSubmit || !hasGetOrdered) {
          return {
            success: false,
            error:
              cmdSubmitError ||
              'No supported write-path found for sending a message. (Missing composer.createNew/triggerCreateWorktreeButton/getOrderedSelectedComposerIds)',
          };
        }

        // Build a compact continuation prompt from recent non-tool messages.
        let recent: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        try {
          const t = await storageReader.getConversationTranscript(sessionId);
          recent = t.messages
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-10)
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '').trim() }))
            .filter((m) => m.content.length > 0);
        } catch {
          recent = [];
        }

        const maxLineLen = 500;
        const historyInline = recent
          .map((m) => {
            const safe = m.content.length > maxLineLen ? m.content.slice(0, maxLineLen) + '…' : m.content;
            // Keep this single-line to avoid UI escaping (\n) in some Cursor surfaces.
            return `${m.role}: ${safe.replace(/\s+/g, ' ')}`;
          })
          .join(' | ');

        const trimmedMessage = message.trim();
        const continuationPrompt =
          (historyInline
            ? `Continue the conversation. Recent context: ${historyInline}. Now respond to: ${trimmedMessage}`
            : trimmedMessage) || trimmedMessage;

        const continuationHash = createHash('sha256').update(continuationPrompt, 'utf8').digest('hex').slice(0, 12);
        const messageHash = createHash('sha256').update(trimmedMessage, 'utf8').digest('hex').slice(0, 12);
        const promptNewlines = (continuationPrompt.match(/\n/g) ?? []).length;
        const promptBackslashN = (continuationPrompt.match(/\\n/g) ?? []).length;

        // Best-effort: keep mode/model consistent with the prior session
        let storedMode: string | null = null;
        let storedModel: { modelName: string; maxMode: boolean } | null = null;
        try {
          storedMode = await storageReader.getComposerUnifiedMode(sessionId);
        } catch {
          storedMode = null;
        }
        try {
          const mc = await storageReader.getComposerModelConfig(sessionId);
          storedModel =
            mc && typeof mc.modelName === 'string' && typeof mc.maxMode === 'boolean' ? { modelName: mc.modelName, maxMode: mc.maxMode } : null;
        } catch {
          storedModel = null;
        }

        const mode =
          storedMode === 'chat' || storedMode === 'agent' || storedMode === 'plan' || storedMode === 'debug' || storedMode === 'background'
            ? storedMode
            : 'agent';

        const beforeSelected =
          (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];

        let createResult: any = null;
        try {
          createResult = await vscode.commands.executeCommand('composer.createNew', {
            openInNewTab: true,
            partialState: {
              unifiedMode: mode,
              text: continuationPrompt,
              richText: continuationPrompt,
              ...(storedModel ? { modelConfig: storedModel } : {}),
            },
          });
        } catch (err) {
          return { success: false, error: `composer.createNew failed: ${String(err)}` };
        }

        const afterSelected =
          (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];

        const createdComposerIdFromResult =
          createResult && typeof createResult === 'object' && 'composerId' in createResult ? String((createResult as any).composerId) : null;
        const newlySelected = afterSelected.find((id) => !beforeSelected.includes(id));
        const newComposerId = createdComposerIdFromResult ?? newlySelected ?? afterSelected[0] ?? null;

        if (!newComposerId) {
          return { success: false, error: 'Created composer but could not determine composerId' };
        }

        // Inspect stored draft fields to debug newline/escape rendering issues.
        try {
          const draft = await storageReader.getComposerDraft(newComposerId);
          const text = draft.text ?? '';
          const richText = draft.richText ?? '';
          const countNewlines = (s: string) => (s.match(/\n/g) ?? []).length;
          const countBackslashN = (s: string) => (s.match(/\\n/g) ?? []).length;
        } catch {
          // ignore
        }

        if (hasOpenComposer) {
          try {
            await vscode.commands.executeCommand('composer.openComposer', newComposerId, {
              focusMainInputBox: true,
              insertSelection: false,
            });
          } catch {
            // ignore
          }
        }

        let submitResult: unknown = null;
        try {
          submitResult = await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
        } catch (err) {
          return { success: false, composerId: newComposerId, error: `submit command failed: ${String(err)}` };
        }

        let afterSubmitSelected: string[] = [];
        try {
          afterSubmitSelected =
            (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
        } catch {
          afterSubmitSelected = [];
        }

        const submitComposerIdFromResult =
          submitResult && typeof submitResult === 'object' && submitResult !== null && 'composerId' in (submitResult as any)
            ? String((submitResult as any).composerId)
            : null;

        // In some flows (e.g. worktree creation), submit may spawn/switch to a different composer.
        const postSubmitNewIds = afterSubmitSelected.filter((id) => !beforeSelected.includes(id));
        const finalComposerId = submitComposerIdFromResult ?? postSubmitNewIds[0] ?? newComposerId;

        // Verify in the NEW composer transcript.
        const start = Date.now();
        let delivered = false;
        let messageCount: number | null = null;
        let lastRole: string | null = null;
        let matchedUserMessage: string | null = null;
        while (!delivered && Date.now() - start < 8000) {
          try {
            const t = await storageReader.getConversationTranscript(finalComposerId);
            messageCount = t.messages.length;
            lastRole = t.messages.at(-1)?.role ?? null;
            const matched = t.messages.find((m) => {
              if (m.role !== 'user') return false;
              const c = String(m.content ?? '');
              const h = createHash('sha256').update(c, 'utf8').digest('hex').slice(0, 12);
              return h === continuationHash || h === messageHash || c.includes(trimmedMessage);
            });
            matchedUserMessage = matched ? String(matched.content ?? '') : null;
            delivered = !!matched;
          } catch {
            // ignore
          }
          if (!delivered) await new Promise((r) => setTimeout(r, 250));
        }

        if (delivered && matchedUserMessage !== null) {
          const msg = matchedUserMessage;
          const nl = (msg.match(/\n/g) ?? []).length;
          const bsn = (msg.match(/\\n/g) ?? []).length;
        }

        return delivered
          ? { success: true, composerId: finalComposerId }
          : { success: false, composerId: finalComposerId, error: 'Created new composer but did not observe user bubble in transcript.' };
      } catch (err) {
        return {
          success: false,
          error: String(err),
        };
      } finally {
        await storageReader.dispose().catch(() => {});
      }
    },

    onGetEnabledModelsRequest: async ({ requestId, instanceId }) => {
      try {
        const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
        const models = await storageReader.getEnabledModels();
        await storageReader.dispose();
        return { success: true, models };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    onCreateChatRequest: async ({ requestId, instanceId, prompt, unifiedMode, modelName, maxMode }) => {
      const promptStr = typeof prompt === 'string' ? prompt : String(prompt);
      const msgHash = createHash('sha256').update(promptStr, 'utf8').digest('hex').slice(0, 12);

      const allCommands = await vscode.commands.getCommands(true);
      const hasCreateNew = allCommands.includes('composer.createNew');
      const hasTriggerSubmit = allCommands.includes('composer.triggerCreateWorktreeButton');
      const hasGetOrdered = allCommands.includes('composer.getOrderedSelectedComposerIds');
      const hasOpenComposer = allCommands.includes('composer.openComposer');

      if (!hasCreateNew || !hasTriggerSubmit || !hasGetOrdered) {
        return {
          success: false,
          error: `Missing required Cursor commands. createNew=${hasCreateNew}, triggerSubmit=${hasTriggerSubmit}, getOrdered=${hasGetOrdered}`,
        };
      }

      const mode =
        unifiedMode === 'chat' || unifiedMode === 'agent' || unifiedMode === 'plan' || unifiedMode === 'debug' || unifiedMode === 'background'
          ? unifiedMode
          : 'agent';

      let beforeSelected: string[] = [];
      try {
        beforeSelected = (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
      } catch {
        beforeSelected = [];
      }

      try {
        await vscode.commands.executeCommand('composer.createNew', {
          openInNewTab: true,
          partialState: {
            unifiedMode: mode,
            text: promptStr,
            richText: promptStr,
            ...(modelName ? { modelConfig: { modelName: String(modelName), maxMode: !!maxMode } } : {}),
          },
        });
      } catch (err) {
        return { success: false, error: `composer.createNew failed: ${String(err)}` };
      }

      let afterSelected: string[] = [];
      try {
        afterSelected = (await vscode.commands.executeCommand<string[]>('composer.getOrderedSelectedComposerIds')) ?? [];
      } catch {
        afterSelected = [];
      }

      const newlySelected = afterSelected.find((id) => !beforeSelected.includes(id));
      const composerId = newlySelected ?? afterSelected[0] ?? null;

      if (!composerId) {
        return { success: false, error: 'Could not determine created composerId' };
      }

      if (hasOpenComposer) {
        try {
          await vscode.commands.executeCommand('composer.openComposer', composerId, {
            focusMainInputBox: true,
            insertSelection: false,
          });
        } catch {
          // ignore
        }
      }

      try {
        await vscode.commands.executeCommand('composer.triggerCreateWorktreeButton');
      } catch (err) {
        return { success: false, composerId, error: `submit command failed: ${String(err)}` };
      }

      const storageReader = new CursorComposerStorageReader(context, { cacheTtlMs: 0 });
      try {
        const start = Date.now();
        let transcript = await storageReader.getConversationTranscript(composerId);
        let delivered =
          transcript.messages.some((m) => m.role === 'user' && createHash('sha256').update(String(m.content), 'utf8').digest('hex').slice(0, 12) === msgHash);

        while (!delivered && Date.now() - start < 8000) {
          await new Promise((r) => setTimeout(r, 250));
          transcript = await storageReader.getConversationTranscript(composerId);
          delivered =
            transcript.messages.some((m) => m.role === 'user' && createHash('sha256').update(String(m.content), 'utf8').digest('hex').slice(0, 12) === msgHash);
        }

        const storedMode = await storageReader.getComposerUnifiedMode(composerId);
        const storedModel = await storageReader.getComposerModelConfig(composerId);

        return delivered
          ? { success: true, composerId }
          : { success: false, composerId, error: `Created composer but did not observe user bubble in transcript (storedMode=${storedMode ?? 'null'})` };
      } finally {
        await storageReader.dispose().catch(() => {});
      }
    },
  });

  try {
    await client.connect();
    // Note: onConnect callback handles status bar update

    // Start the Cursor adapter with rich SQLite metadata support
    adapter = createCursorAdapter(client, context);
    adapter.start();
  } catch (err) {
    console.error('[Deadhand] Failed to connect:', err);
    updateStatusBar('error', 'Connection failed');

    // Retry after delay (client will also retry internally)
    setTimeout(() => connectToDaemon(context), 10000);
  }
}

function updateStatusBar(status: 'connected' | 'error' | 'disconnected', tooltip: string) {
  if (!statusBarItem) return;

  switch (status) {
    case 'connected':
      statusBarItem.text = '$(broadcast) Deadhand';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(warning) Deadhand';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
    case 'disconnected':
      statusBarItem.text = '$(circle-slash) Deadhand';
      statusBarItem.backgroundColor = undefined;
      break;
  }

  statusBarItem.tooltip = `Deadhand: ${tooltip}`;
}

async function showStatus() {
  const config = getConfig();
  const running = await isDaemonRunning();
  const connected = client?.isConnected() ?? false;

  const items: vscode.QuickPickItem[] = [
    {
      label: `$(server) Daemon: ${running ? 'Running' : 'Not running'}`,
      description: `Port ${config.daemonPort}`,
    },
    {
      label: `$(plug) Connection: ${connected ? 'Connected' : 'Disconnected'}`,
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(globe) Open Web UI', description: 'Open in browser' },
    { label: '$(refresh) Reconnect', description: 'Reconnect to daemon' },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Deadhand Status',
    placeHolder: 'Select an action',
  });

  if (selected?.label.includes('Open Web UI')) {
    openWebUI();
  } else if (selected?.label.includes('Reconnect')) {
    const context = { extensionPath: '' } as vscode.ExtensionContext; // Simplified
    await connectToDaemon(context);
  }
}

function openWebUI() {
  const config = getConfig();
  const url = `http://localhost:${config.daemonPort}`;
  vscode.env.openExternal(vscode.Uri.parse(url));
}

async function rotateToken() {
  vscode.window.showInformationMessage(
    'Token rotation requires restarting the daemon. Please restart manually.'
  );
}

async function showPairing() {
  // Focus the Deadhand view in the Explorer sidebar
  await vscode.commands.executeCommand('deadhand.pairingView.focus');
}

async function copyToken() {
  const token = readToken();
  if (token) {
    await vscode.env.clipboard.writeText(token);
    vscode.window.showInformationMessage('Deadhand: Token copied to clipboard');
  } else {
    vscode.window.showWarningMessage('Deadhand: No token found. Is the daemon running?');
  }
}

async function copyWebUrl() {
  const config = getConfig();
  const daemonInfo = await probeDaemon();
  const token = readToken();

  if (!daemonInfo.reachable) {
    vscode.window.showWarningMessage('Deadhand: Daemon not reachable');
    return;
  }

  const url = buildWebUrl(
    daemonInfo.scheme!,
    'localhost',
    config.daemonPort,
    token || undefined
  );

  await vscode.env.clipboard.writeText(url);
  vscode.window.showInformationMessage('Deadhand: URL copied to clipboard');
}

async function refreshPairing() {
  if (pairingViewProvider) {
    await pairingViewProvider.refresh();
  }
}

export function deactivate() {
  console.log('[Deadhand] Extension deactivating...');

  if (adapter) {
    adapter.stop();
    adapter = null;
  }

  if (client) {
    client.disconnect();
    client = null;
  }

  // Note: We don't stop the daemon on deactivate because other instances may be using it
}


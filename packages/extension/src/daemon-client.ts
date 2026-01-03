import * as vscode from 'vscode';
import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import type { ExtensionMessage, Instance, Session, TranscriptEvent, DaemonToExtensionMessage } from './types';
import { getConfig } from './config';
import { probeDaemon } from './utils/daemonProbe';

export interface DaemonClientOptions {
  /** Called when initially connected or reconnected after disconnection */
  onConnect?: () => void;
  /** Called when connection is lost */
  onDisconnect?: () => void;
  /** Called when daemon requests sending a message to a session */
  onSendMessageRequest?: (
    sessionId: string,
    message: string,
    requestId: string
  ) => Promise<{ success: boolean; composerId?: string; error?: string }>;

  /** Called when daemon requests creating a new chat/composer and submitting a prompt */
  onCreateChatRequest?: (req: {
    requestId: string;
    instanceId: string;
    prompt: string;
    unifiedMode: string;
    modelName?: string;
    maxMode?: boolean;
  }) => Promise<{ success: boolean; composerId?: string; error?: string }>;

  /** Called when daemon requests the enabled model list for this Cursor instance */
  onGetEnabledModelsRequest?: (req: { requestId: string; instanceId: string }) => Promise<{ success: boolean; models?: any[]; error?: string }>;
}

export interface DaemonClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  sendHeartbeat(): void;
  startSession(session: Omit<Session, 'instanceId'>): void;
  updateSession(session: Partial<Session> & { sessionId: string }): void;
  endSession(sessionId: string): void;
  sendTranscriptEvent(event: TranscriptEvent): void;
  getInstanceId(): string | null;
}

export function createDaemonClient(options: DaemonClientOptions = {}): DaemonClient {
  const { onConnect, onDisconnect, onSendMessageRequest, onCreateChatRequest, onGetEnabledModelsRequest } = options;
  
  let ws: WebSocket | null = null;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let connected = false;
  let wasConnectedBefore = false;
  let instanceId: string | null = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30000; // 30 seconds max
  let allowReconnect = true;

  function getInstanceData(): Instance {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceName = workspaceFolders?.[0]?.name || 'Unknown';
    const workspacePath = workspaceFolders?.[0]?.uri.fsPath || '';

    return {
      instanceId: instanceId || nanoid(),
      app: 'Cursor', // TODO: detect VS Code vs Cursor
      appVersion: vscode.version,
      workspaceName,
      workspacePath,
      pid: process.pid,
    };
  }

  function send(message: ExtensionMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function scheduleReconnect(reason?: string) {
    if (!allowReconnect) return;
    if (reconnectTimeout) return; // already scheduled
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to MAX_RECONNECT_DELAY
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    
    console.log(`[Deadhand] Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
    
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      console.log('[Deadhand] Reconnecting to daemon...');
      connect().catch((err) => {
        console.error('[Deadhand] Reconnect failed:', err.message);
        // If connect fails before a websocket is established (e.g., daemon is still starting),
        // there will be no close handler to reschedule. Explicitly retry.
        scheduleReconnect('connect_failed');
      });
    }, delay);
  }

  async function connect(): Promise<void> {
    allowReconnect = true;

    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    const config = getConfig();
    
    // Probe daemon to determine which protocol to use
    const daemonInfo = await probeDaemon();
    
    if (!daemonInfo.reachable) {
      throw new Error('Daemon not reachable');
    }

    const wsScheme = daemonInfo.scheme === 'https' ? 'wss' : 'ws';
    const wsUrl = `${wsScheme}://127.0.0.1:${config.daemonPort}/ws/extension`;

    return new Promise((resolve, reject) => {
      // For WSS, we need to accept self-signed certificates
      const wsOptions = daemonInfo.scheme === 'https' 
        ? { rejectUnauthorized: false }
        : {};

      ws = new WebSocket(wsUrl, wsOptions);

      ws.on('open', () => {
        connected = true;
        reconnectAttempts = 0; // Reset backoff on successful connection
        
        const instance = getInstanceData();
        instanceId = instance.instanceId;

        // Register with daemon
        send({ type: 'register', instance });

        // Start heartbeat
        heartbeatInterval = setInterval(() => {
          send({ type: 'heartbeat' });
        }, 30000); // Every 30 seconds

        const isReconnect = wasConnectedBefore;
        wasConnectedBefore = true;

        console.log(`[Deadhand] ${isReconnect ? 'Reconnected' : 'Connected'} to daemon`);
        
        // Notify listener (triggers resync on reconnect)
        onConnect?.();
        
        resolve();
      });

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString()) as DaemonToExtensionMessage;
          
          if (message.type === 'send_message_request') {
            console.log(`[Deadhand] Received send_message_request for session ${message.sessionId.slice(0, 8)}...`);
            
            if (onSendMessageRequest) {
              const result = await onSendMessageRequest(message.sessionId, message.message, message.requestId);
              send({
                type: 'send_message_result',
                sessionId: message.sessionId,
                requestId: message.requestId,
                success: result.success,
                composerId: (result as any).composerId,
                error: result.error,
              });
            } else {
              send({
                type: 'send_message_result',
                sessionId: message.sessionId,
                requestId: message.requestId,
                success: false,
                error: 'Send message handler not configured',
              });
            }
          }

          if (message.type === 'get_enabled_models_request') {
            if (onGetEnabledModelsRequest) {
              const res = await onGetEnabledModelsRequest({ requestId: message.requestId, instanceId: message.instanceId });
              send({
                type: 'enabled_models_result',
                requestId: message.requestId,
                instanceId: message.instanceId,
                success: res.success,
                models: res.models,
                error: res.error,
              } as any);
            } else {
              send({
                type: 'enabled_models_result',
                requestId: message.requestId,
                instanceId: message.instanceId,
                success: false,
                error: 'Enabled models handler not configured',
              } as any);
            }
          }

          if (message.type === 'create_chat_request') {
            if (onCreateChatRequest) {
              const res = await onCreateChatRequest({
                requestId: message.requestId,
                instanceId: message.instanceId,
                prompt: message.prompt,
                unifiedMode: (message as any).unifiedMode,
                modelName: (message as any).modelName,
                maxMode: (message as any).maxMode,
              });
              send({
                type: 'create_chat_result',
                requestId: message.requestId,
                success: res.success,
                composerId: res.composerId,
                error: res.error,
              } as any);
            } else {
              send({
                type: 'create_chat_result',
                requestId: message.requestId,
                success: false,
                error: 'Create chat handler not configured',
              } as any);
            }
          }
        } catch (err) {
          console.error('[Deadhand] Error handling daemon message:', err);
        }
      });

      ws.on('close', (code, reason) => {
        const wasConnected = connected;
        connected = false;
        
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        // Notify listener of disconnection
        if (wasConnected) {
          onDisconnect?.();
        }

        // Schedule reconnect with exponential backoff (unless manually disconnected)
        scheduleReconnect('ws_close');
      });

      ws.on('error', (err) => {
        console.error('[Deadhand] WebSocket error:', err.message);
        if (!connected) {
          reject(err);
        }
      });
    });
  }

  function disconnect() {
    allowReconnect = false;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
  }

  return {
    connect,
    disconnect,
    isConnected: () => connected,
    getInstanceId: () => instanceId,
    sendHeartbeat: () => send({ type: 'heartbeat' }),

    startSession(session) {
      if (!instanceId) return;
      send({
        type: 'session_start',
        session: { ...session, instanceId },
      });
    },

    updateSession(session) {
      send({
        type: 'session_update',
        session,
      });
    },

    endSession(sessionId) {
      send({ type: 'session_end', sessionId });
    },

    sendTranscriptEvent(event) {
      send({ type: 'transcript_event', event });
    },
  };
}


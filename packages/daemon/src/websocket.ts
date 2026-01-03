import type { WebSocket } from 'ws';
import type { InstanceRegistry } from './registry.js';
import type { AuthManager } from './auth.js';
import type { WSClientMessage, WSServerMessage, ExtensionMessage, DaemonToExtensionMessage } from './types.js';

interface ClientConnection {
  ws: WebSocket;
  authenticated: boolean;
  subscribedInstances: boolean;
  subscribedSessions: Set<string>;
}

interface ExtensionConnection {
  ws: WebSocket;
  instanceId: string | null;
}

interface PendingMessageRequest {
  clientWs: WebSocket;
  sessionId: string;
  requestId: string;
  timestamp: number;
}

interface PendingEnabledModelsRequest {
  clientWs: WebSocket;
  instanceId: string;
  requestId: string;
  timestamp: number;
}

interface PendingCreateChatRequest {
  clientWs: WebSocket;
  instanceId: string;
  requestId: string;
  timestamp: number;
}

export interface WebSocketManager {
  handleClientConnection(ws: WebSocket, token: string | undefined): void;
  handleExtensionConnection(ws: WebSocket): void;
  broadcastToClients(message: WSServerMessage): void;
  broadcastToSessionSubscribers(sessionId: string, message: WSServerMessage): void;
}

export function createWebSocketManager(
  registry: InstanceRegistry,
  authManager: AuthManager
): WebSocketManager {
  const clients = new Set<ClientConnection>();
  const extensions = new Set<ExtensionConnection>();
  const pendingMessageRequests = new Map<string, PendingMessageRequest>();
  const pendingEnabledModelsRequests = new Map<string, PendingEnabledModelsRequest>();
  const pendingCreateChatRequests = new Map<string, PendingCreateChatRequest>();

  // Clean up old pending requests every 30 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [requestId, request] of pendingMessageRequests) {
      // Timeout after 30 seconds
      if (now - request.timestamp > 30000) {
        pendingMessageRequests.delete(requestId);
        // Notify client of timeout
        const msg: WSServerMessage = {
          type: 'send_message_result',
          sessionId: request.sessionId,
          success: false,
          error: 'Request timed out',
        };
        try {
          request.clientWs.send(JSON.stringify(msg));
        } catch {
          // Client may have disconnected
        }
      }
    }

    for (const [requestId, request] of pendingEnabledModelsRequests) {
      if (now - request.timestamp > 30000) {
        pendingEnabledModelsRequests.delete(requestId);
        const msg: WSServerMessage = {
          type: 'enabled_models_result',
          requestId,
          instanceId: request.instanceId,
          success: false,
          error: 'Request timed out',
        };
        try {
          request.clientWs.send(JSON.stringify(msg));
        } catch {
          // ignore
        }
      }
    }

    for (const [requestId, request] of pendingCreateChatRequests) {
      if (now - request.timestamp > 30000) {
        pendingCreateChatRequests.delete(requestId);
        const msg: WSServerMessage = {
          type: 'create_chat_result',
          requestId,
          success: false,
          error: 'Request timed out',
        };
        try {
          request.clientWs.send(JSON.stringify(msg));
        } catch {
          // ignore
        }
      }
    }
  }, 30000);

  // Subscribe to registry events and broadcast to clients
  registry.onInstanceChange((type, instance) => {
    const message: WSServerMessage =
      type === 'disconnect'
        ? { type: 'instance_disconnect', instanceId: instance.instanceId }
        : { type: 'instance_update', instance };

    broadcastToInstanceSubscribers(message);
  });

  registry.onSessionChange((_type, session) => {
    const message: WSServerMessage = { type: 'session_update', session };
    
    // Broadcast to specific session subscribers
    broadcastToSessionSubscribers(session.sessionId, message);
    
    // ALSO broadcast ALL session changes to instance subscribers
    // so they can see sessions appear, update, and disappear in real-time
    broadcastToInstanceSubscribers(message);
  });

  registry.onTranscriptEvent((event) => {
    const message: WSServerMessage = { type: 'transcript_event', event };
    broadcastToSessionSubscribers(event.sessionId, message);
  });

  function broadcastToInstanceSubscribers(message: WSServerMessage) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.authenticated && client.subscribedInstances) {
        client.ws.send(data);
      }
    }
  }

  function broadcastToSessionSubscribers(sessionId: string, message: WSServerMessage) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.authenticated && client.subscribedSessions.has(sessionId)) {
        client.ws.send(data);
      }
    }
  }

  function handleClientMessage(client: ClientConnection, message: WSClientMessage) {
    switch (message.type) {
      case 'subscribe_instances':
        client.subscribedInstances = true;
        // Send current instances
        const allInstances = registry.getAllInstances();
        for (const instance of allInstances) {
          const msg: WSServerMessage = { type: 'instance_update', instance };
          client.ws.send(JSON.stringify(msg));
        }
        
        // Send ALL sessions (including persisted ones without connected instances)
        const allSessions = registry.getAllSessions();
        for (const session of allSessions) {
          const sessionMsg: WSServerMessage = { type: 'session_update', session };
          client.ws.send(JSON.stringify(sessionMsg));
        }
        break;

      case 'unsubscribe_instances':
        client.subscribedInstances = false;
        break;

      case 'subscribe_session':
        client.subscribedSessions.add(message.sessionId);
        // Send current transcript events
        const events = registry.getTranscriptEvents(message.sessionId);
        for (const event of events) {
          const msg: WSServerMessage = { type: 'transcript_event', event };
          client.ws.send(JSON.stringify(msg));
        }
        break;

      case 'unsubscribe_session':
        client.subscribedSessions.delete(message.sessionId);
        break;

      case 'ping':
        client.ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'send_message':
        // Disabled: sending messages to an existing session is not reliable in this Cursor build (composer input is a webview).
        // Users should use create_chat (new composer) instead.
        client.ws.send(
          JSON.stringify({
            type: 'send_message_result',
            sessionId: message.sessionId,
            success: false,
            error: 'Send-message to an existing session is temporarily disabled. Use New Chat instead.',
          } satisfies WSServerMessage)
        );
        break;

      case 'get_enabled_models': {
        // Route request to the specified instance's extension
        const targetInstanceId = message.instanceId;
        let targetExtension: ExtensionConnection | null = null;
        for (const ext of extensions) {
          if (ext.instanceId === targetInstanceId) {
            targetExtension = ext;
            break;
          }
        }

        if (!targetExtension) {
          const errorMsg: WSServerMessage = {
            type: 'enabled_models_result',
            requestId: message.requestId,
            instanceId: targetInstanceId,
            success: false,
            error: 'Extension not connected for this instance',
          };
          client.ws.send(JSON.stringify(errorMsg));
          break;
        }

        pendingEnabledModelsRequests.set(message.requestId, {
          clientWs: client.ws,
          instanceId: targetInstanceId,
          requestId: message.requestId,
          timestamp: Date.now(),
        });

        const extMsg: DaemonToExtensionMessage = {
          type: 'get_enabled_models_request',
          requestId: message.requestId,
          instanceId: targetInstanceId,
        };
        try {
          targetExtension.ws.send(JSON.stringify(extMsg));
        } catch (err) {
          pendingEnabledModelsRequests.delete(message.requestId);
          const errorMsg: WSServerMessage = {
            type: 'enabled_models_result',
            requestId: message.requestId,
            instanceId: targetInstanceId,
            success: false,
            error: `Failed to forward to extension: ${String(err)}`,
          };
          try {
            client.ws.send(JSON.stringify(errorMsg));
          } catch {
            // ignore
          }
        }
        break;
      }

      case 'create_chat': {
        const targetInstanceId = message.instanceId;
        let targetExtension: ExtensionConnection | null = null;
        for (const ext of extensions) {
          if (ext.instanceId === targetInstanceId) {
            targetExtension = ext;
            break;
          }
        }

        if (!targetExtension) {
          const errorMsg: WSServerMessage = {
            type: 'create_chat_result',
            requestId: message.requestId,
            success: false,
            error: 'Extension not connected for this instance',
          };
          client.ws.send(JSON.stringify(errorMsg));
          break;
        }

        pendingCreateChatRequests.set(message.requestId, {
          clientWs: client.ws,
          instanceId: targetInstanceId,
          requestId: message.requestId,
          timestamp: Date.now(),
        });

        const extMsg: DaemonToExtensionMessage = {
          type: 'create_chat_request',
          requestId: message.requestId,
          instanceId: targetInstanceId,
          prompt: message.prompt,
          unifiedMode: message.unifiedMode,
          modelName: message.modelName,
          maxMode: message.maxMode,
        };
        try {
          targetExtension.ws.send(JSON.stringify(extMsg));
        } catch (err) {
          pendingCreateChatRequests.delete(message.requestId);
          const errorMsg: WSServerMessage = {
            type: 'create_chat_result',
            requestId: message.requestId,
            success: false,
            error: `Failed to forward to extension: ${String(err)}`,
          };
          try {
            client.ws.send(JSON.stringify(errorMsg));
          } catch {
            // ignore
          }
        }
        break;
      }
    }
  }

  function handleExtensionMessage(conn: ExtensionConnection, message: ExtensionMessage) {
    switch (message.type) {
      case 'register':
        const instance = registry.registerInstance(message.instance);
        conn.instanceId = instance.instanceId;
        console.log(`Extension registered: ${instance.workspaceName} (${instance.instanceId})`);
        break;

      case 'heartbeat':
        if (conn.instanceId) {
          registry.updateHeartbeat(conn.instanceId);
        }
        break;

      case 'session_start':
        if (conn.instanceId) {
          registry.startSession(conn.instanceId, message.session);
        }
        break;

      case 'session_update':
        registry.updateSession(message.session.sessionId, message.session);
        break;

      case 'session_end':
        registry.endSession(message.sessionId);
        break;

      case 'transcript_event':
        registry.addTranscriptEvent(message.event);
        break;

      case 'send_message_result':
        // Extension reporting back the result of a send_message request
        const pending = pendingMessageRequests.get(message.requestId);
        if (pending) {
          pendingMessageRequests.delete(message.requestId);
          const resultMsg: WSServerMessage = {
            type: 'send_message_result',
            sessionId: message.sessionId,
            success: message.success,
            composerId: (message as any).composerId,
            error: message.error,
          };
          try {
            pending.clientWs.send(JSON.stringify(resultMsg));
          } catch {
            // Client may have disconnected
          }
        }
        break;

      case 'enabled_models_result': {
        const pending = pendingEnabledModelsRequests.get(message.requestId);
        if (pending) {
          pendingEnabledModelsRequests.delete(message.requestId);
          const msg: WSServerMessage = {
            type: 'enabled_models_result',
            requestId: message.requestId,
            instanceId: message.instanceId,
            success: message.success,
            models: message.models,
            error: message.error,
          };
          try {
            pending.clientWs.send(JSON.stringify(msg));
          } catch {
            // ignore
          }
        }
        break;
      }

      case 'create_chat_result': {
        const pending = pendingCreateChatRequests.get(message.requestId);
        if (pending) {
          pendingCreateChatRequests.delete(message.requestId);
          const msg: WSServerMessage = {
            type: 'create_chat_result',
            requestId: message.requestId,
            success: message.success,
            composerId: message.composerId,
            error: message.error,
          };
          try {
            pending.clientWs.send(JSON.stringify(msg));
          } catch {
            // ignore
          }
        }
        break;
      }
    }
  }

  return {
    handleClientConnection(ws, token) {
      const authenticated = authManager.validateToken(token);

      const client: ClientConnection = {
        ws,
        authenticated,
        subscribedInstances: false,
        subscribedSessions: new Set(),
      };

      if (!authenticated) {
        const msg: WSServerMessage = { type: 'error', message: 'Invalid or missing token' };
        ws.send(JSON.stringify(msg));
        ws.close(4001, 'Unauthorized');
        return;
      }

      clients.add(client);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as WSClientMessage;
          handleClientMessage(client, message);
        } catch (err) {
          const msg: WSServerMessage = { type: 'error', message: 'Invalid message format' };
          ws.send(JSON.stringify(msg));
        }
      });

      ws.on('close', () => {
        clients.delete(client);
      });
    },

    handleExtensionConnection(ws) {
      const conn: ExtensionConnection = {
        ws,
        instanceId: null,
      };

      extensions.add(conn);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as ExtensionMessage;
          handleExtensionMessage(conn, message);
        } catch (err) {
          console.error('Invalid extension message:', err);
        }
      });

      ws.on('close', () => {
        if (conn.instanceId) {
          registry.removeInstance(conn.instanceId);
          console.log(`Extension disconnected: ${conn.instanceId}`);
        }
        extensions.delete(conn);
      });
    },

    broadcastToClients(message) {
      const data = JSON.stringify(message);
      for (const client of clients) {
        if (client.authenticated) {
          client.ws.send(data);
        }
      }
    },

    broadcastToSessionSubscribers(sessionId, message) {
      broadcastToSessionSubscribers(sessionId, message);
    },
  };
}


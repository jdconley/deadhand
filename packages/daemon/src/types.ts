// Core data types for Deadhand daemon

export interface Instance {
  instanceId: string;
  app: string;
  appVersion: string;
  workspaceName: string;
  workspacePath: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
}

export type SessionMode = 'agent' | 'chat' | 'plan' | 'debug' | 'background' | 'unknown';

export interface Session {
  sessionId: string;
  instanceId: string;
  title: string;
  createdAt: string;
  status: 'active' | 'idle' | 'error';
  // Rich metadata from Cursor's composer data
  mode?: SessionMode;
  lastUpdatedAt?: string;
  contextUsagePercent?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  filesChangedCount?: number;
  subtitle?: string;
  model?: string;
}

export type TranscriptEventType = 'message' | 'delta' | 'tool_start' | 'tool_end' | 'status';

export interface TranscriptEvent {
  eventId: string;
  sessionId: string;
  ts: string;
  type: TranscriptEventType;
  payload: Record<string, unknown>;
  /** Optional stable source ID for deduplication (e.g., from Cursor's message ID) */
  sourceId?: string;
}

export interface EnabledModel {
  /** Internal model id (e.g. composer-1, gpt-5.2-extra-high-fast) */
  name: string;
  /** UI display label (e.g. "GPT-5.2 Extra High Fast") */
  clientDisplayName?: string;
  /** Server model name (often same as name) */
  serverModelName?: string;
  /** Whether model supports max mode */
  supportsMaxMode?: boolean;
  /** Whether model supports thinking variants */
  supportsThinking?: boolean;
}

// WebSocket message types
export type WSClientMessage =
  | { type: 'subscribe_instances' }
  | { type: 'subscribe_session'; sessionId: string }
  | { type: 'unsubscribe_instances' }
  | { type: 'unsubscribe_session'; sessionId: string }
  | { type: 'ping' }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'get_enabled_models'; requestId: string; instanceId: string }
  | {
      type: 'create_chat';
      requestId: string;
      instanceId: string;
      prompt: string;
      /** Cursor internal unifiedMode (Ask in UI maps to chat) */
      unifiedMode: SessionMode;
      modelName?: string;
      maxMode?: boolean;
    };

export type WSServerMessage =
  | { type: 'instance_update'; instance: Instance }
  | { type: 'instance_disconnect'; instanceId: string }
  | { type: 'session_update'; session: Session }
  | { type: 'transcript_event'; event: TranscriptEvent }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'send_message_result'; sessionId: string; success: boolean; composerId?: string; error?: string }
  | { type: 'enabled_models_result'; requestId: string; instanceId: string; success: boolean; models?: EnabledModel[]; error?: string }
  | { type: 'create_chat_result'; requestId: string; success: boolean; composerId?: string; error?: string };

// Internal extension connection messages (different from web client)
export type ExtensionMessage =
  | { type: 'register'; instance: Omit<Instance, 'startedAt' | 'lastSeenAt'> }
  | { type: 'heartbeat' }
  | { type: 'session_start'; session: Omit<Session, 'createdAt'> }
  | { type: 'session_update'; session: Partial<Session> & { sessionId: string } }
  | { type: 'session_end'; sessionId: string }
  | { type: 'transcript_event'; event: Omit<TranscriptEvent, 'eventId' | 'ts'> & { sourceId?: string } }
  | { type: 'send_message_result'; sessionId: string; requestId: string; success: boolean; composerId?: string; error?: string }
  | { type: 'enabled_models_result'; requestId: string; instanceId: string; success: boolean; models?: EnabledModel[]; error?: string }
  | { type: 'create_chat_result'; requestId: string; success: boolean; composerId?: string; error?: string };

// Message from daemon to extension (to request sending a message)
export type DaemonToExtensionMessage =
  | { type: 'send_message_request'; sessionId: string; message: string; requestId: string }
  | { type: 'get_enabled_models_request'; requestId: string; instanceId: string }
  | {
      type: 'create_chat_request';
      requestId: string;
      instanceId: string;
      prompt: string;
      unifiedMode: SessionMode;
      modelName?: string;
      maxMode?: boolean;
    };

export interface DaemonConfig {
  port: number;
  host: string;
  dataDir: string;
  localhostOnly: boolean;
}


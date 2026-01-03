// Shared types with daemon

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

export function getModeLabel(mode?: SessionMode): string {
  switch (mode) {
    case 'agent':
      return 'Agent';
    case 'chat':
      return 'Ask';
    case 'plan':
      return 'Plan';
    case 'debug':
      return 'Debug';
    case 'background':
      return 'Background';
    default:
      return 'Unknown';
  }
}

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
  /** Optional stable source ID for deduplication */
  sourceId?: string;
}

export interface EnabledModel {
  name: string;
  clientDisplayName?: string;
  serverModelName?: string;
  supportsMaxMode?: boolean;
  supportsThinking?: boolean;
}

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


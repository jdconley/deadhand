// Extension message types (matching daemon)

export interface Instance {
  instanceId: string;
  app: string;
  appVersion: string;
  workspaceName: string;
  workspacePath: string;
  pid: number;
}

export type SessionMode = 'agent' | 'chat' | 'plan' | 'debug' | 'background' | 'unknown';

export interface Session {
  sessionId: string;
  instanceId: string;
  title: string;
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
  sessionId: string;
  type: TranscriptEventType;
  payload: Record<string, unknown>;
  /** Stable source ID for deduplication (e.g., from Cursor's message ID or derived hash) */
  sourceId?: string;
}

export type ExtensionMessage =
  | { type: 'register'; instance: Instance }
  | { type: 'heartbeat' }
  | { type: 'session_start'; session: Session }
  | { type: 'session_update'; session: Partial<Session> & { sessionId: string } }
  | { type: 'session_end'; sessionId: string }
  | { type: 'transcript_event'; event: TranscriptEvent }
  | { type: 'send_message_result'; sessionId: string; requestId: string; success: boolean; composerId?: string; error?: string }
  | {
      type: 'enabled_models_result';
      requestId: string;
      instanceId: string;
      success: boolean;
      models?: Array<{ name: string; clientDisplayName?: string; serverModelName?: string; supportsMaxMode?: boolean; supportsThinking?: boolean }>;
      error?: string;
    }
  | { type: 'create_chat_result'; requestId: string; success: boolean; composerId?: string; error?: string };

// Message from daemon to extension (request to send a message)
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


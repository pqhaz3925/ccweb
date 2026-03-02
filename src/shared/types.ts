export interface CCWebConfig {
  claude: {
    apiUrl: string | null;
    apiKey: string | null;
  };
  web: {
    port: number;
    host: string;
  };
  telegram: {
    token: string | null;
    allowedUsers: number[];
  };
  session: {
    timeoutMs: number;
    watchdogIntervalMs: number;
    defaultProject: string | null;
  };
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'error' | 'dead';

export interface SessionInfo {
  id: string;
  projectId: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  tokensUsed: number;
  costUsd: number;
  sdkSessionId: string | null;
}

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'status' | 'error' | 'result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// Messages from client -> server
export type ClientMessage =
  | { type: 'send_prompt'; prompt: string; projectPath?: string }
  | { type: 'interrupt' }
  | { type: 'restart' }
  | { type: 'status' }
  | { type: 'set_project'; path: string };

// Messages from server -> client
export type ServerMessage =
  | { type: 'chunk'; chunk: StreamChunk }
  | { type: 'session_started'; session: SessionInfo }
  | { type: 'session_ended'; session: SessionInfo; reason: string }
  | { type: 'session_error'; error: string }
  | { type: 'status'; session: SessionInfo | null; project: Project | null }
  | { type: 'connected'; version: string };

import { EventEmitter } from 'node:events';
import type { StreamChunk, SessionInfo } from './types.js';

export interface SessionEvents {
  'chunk': (chunk: StreamChunk, sessionId: string) => void;
  'started': (session: SessionInfo) => void;
  'ended': (session: SessionInfo, reason: string) => void;
  'error': (error: Error, sessionId: string) => void;
  'status_change': (session: SessionInfo) => void;
}

export class TypedEmitter extends EventEmitter {
  override on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return super.on(event, listener);
  }
  override off<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return super.off(event, listener);
  }
  override emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}

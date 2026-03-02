import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage, SDKAssistantMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, StreamChunk, SessionStatus } from '../shared/types.js';
import { getDb } from './db.js';

export class Session {
  readonly id: string;
  readonly projectPath: string;
  readonly emitter = new TypedEmitter();

  private status: SessionStatus = 'idle';
  private abortController: AbortController | null = null;
  private sdkSessionId: string | null = null;
  private tokensUsed = 0;
  private costUsd = 0;
  private startedAt: string;
  private lastActivityAt: string;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastEventTime = 0;
  private timeoutMs: number;
  private watchdogIntervalMs: number;

  constructor(projectPath: string, opts: { timeoutMs: number; watchdogIntervalMs: number }) {
    this.id = randomUUID();
    this.projectPath = projectPath;
    this.startedAt = new Date().toISOString();
    this.lastActivityAt = this.startedAt;
    this.timeoutMs = opts.timeoutMs;
    this.watchdogIntervalMs = opts.watchdogIntervalMs;

    const db = getDb();
    db.prepare(
      `INSERT INTO sessions (id, project_path, status, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)`
    ).run(this.id, projectPath, 'idle', this.startedAt, this.lastActivityAt);
  }

  getInfo(): SessionInfo {
    return {
      id: this.id,
      projectId: this.projectPath,
      status: this.status,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      tokensUsed: this.tokensUsed,
      costUsd: this.costUsd,
      sdkSessionId: this.sdkSessionId,
    };
  }

  async sendPrompt(prompt: string, opts?: { resume?: string; env?: Record<string, string> }): Promise<void> {
    if (this.status === 'running') {
      throw new Error('Session already running. Interrupt first.');
    }

    this.abortController = new AbortController();
    this.setStatus('running');
    this.lastEventTime = Date.now();
    this.startWatchdog();

    const envVars: Record<string, string | undefined> = { ...process.env, ...opts?.env };

    try {
      const q = sdkQuery({
        prompt,
        options: {
          abortController: this.abortController,
          cwd: this.projectPath,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          resume: opts?.resume ?? this.sdkSessionId ?? undefined,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          env: envVars,
        },
      });

      for await (const message of q) {
        this.lastEventTime = Date.now();
        this.lastActivityAt = new Date().toISOString();
        this.processMessage(message);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.setStatus('interrupted');
        this.emitChunk('status', 'Session interrupted');
        return;
      }
      this.setStatus('error');
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emitChunk('error', errorMsg);
      this.emitter.emit('error', err instanceof Error ? err : new Error(errorMsg));
    } finally {
      this.stopWatchdog();
      if ((this.status as string) === 'running') {
        this.setStatus('idle');
      }
      this.updateDb();
    }
  }

  async interrupt(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setStatus('interrupted');
    this.stopWatchdog();
  }

  private processMessage(message: SDKMessage) {
    switch (message.type) {
      case 'assistant': {
        const msg = message as SDKAssistantMessage;
        this.sdkSessionId = msg.session_id;
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            this.emitChunk('text', block.text);
          } else if (block.type === 'tool_use') {
            this.emitChunk('tool_use', JSON.stringify({ tool: block.name, input: block.input }));
          }
        }
        if (msg.message.usage) {
          this.tokensUsed += (msg.message.usage.input_tokens ?? 0) + (msg.message.usage.output_tokens ?? 0);
        }
        break;
      }
      case 'stream_event': {
        const partial = message as SDKPartialAssistantMessage;
        const evt = partial.event;
        if ('delta' in evt && evt.delta && 'text' in evt.delta) {
          this.emitChunk('text', evt.delta.text);
        }
        break;
      }
      case 'result': {
        const result = message as SDKResultMessage;
        this.sdkSessionId = result.session_id;
        this.costUsd = result.total_cost_usd;
        this.tokensUsed = (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0);
        if (result.subtype === 'success') {
          this.emitChunk('result', result.result);
        } else {
          this.emitChunk('error', `Session ended: ${result.subtype}`);
        }
        this.emitter.emit('ended', this.getInfo(), result.subtype);
        break;
      }
      case 'system': {
        if ('subtype' in message) {
          if (message.subtype === 'init') {
            this.emitChunk('system', `Claude Code ${(message as any).claude_code_version} initialized`);
          } else if (message.subtype === 'status') {
            const status = (message as any).status;
            if (status === 'compacting') {
              this.emitChunk('status', 'Compacting context...');
            }
          }
        }
        break;
      }
    }
  }

  private emitChunk(type: StreamChunk['type'], content: string, metadata?: Record<string, unknown>) {
    const chunk: StreamChunk = { type, content, timestamp: Date.now(), metadata };
    this.emitter.emit('chunk', chunk);

    const db = getDb();
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?)`
    ).run(this.id, type, content, new Date().toISOString(), metadata ? JSON.stringify(metadata) : null);
  }

  private setStatus(status: SessionStatus) {
    this.status = status;
    this.emitter.emit('status_change', this.getInfo());
    this.updateDb();
  }

  private updateDb() {
    const db = getDb();
    db.prepare(
      `UPDATE sessions SET status = ?, last_activity_at = ?, tokens_used = ?, cost_usd = ?, sdk_session_id = ? WHERE id = ?`
    ).run(this.status, this.lastActivityAt, this.tokensUsed, this.costUsd, this.sdkSessionId, this.id);
  }

  private startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastEventTime;
      if (elapsed > this.timeoutMs) {
        console.warn(`[watchdog] Session ${this.id} timed out after ${elapsed}ms`);
        this.interrupt();
        this.setStatus('dead');
        this.emitChunk('error', `Session timed out after ${Math.round(elapsed / 1000)}s of inactivity`);
        this.emitter.emit('ended', this.getInfo(), 'watchdog_timeout');
      }
    }, this.watchdogIntervalMs);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

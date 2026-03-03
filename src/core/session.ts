import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage, SDKAssistantMessage, SDKPartialAssistantMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, StreamChunk, SessionStatus } from '../shared/types.js';
import { getDb } from './db.js';

interface QuestionOption { label: string; description: string }
interface QuestionItem { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
interface PendingQuestion {
  questions: QuestionItem[];
  resolve: (answer: string) => void;
}

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
  private hasInitialized = false;
  private promptCount = 0;
  private pendingQuestion: PendingQuestion | null = null;

  constructor(projectPath: string, opts: { timeoutMs: number; watchdogIntervalMs: number; restore?: { id: string; sdkSessionId: string | null; startedAt: string; tokensUsed: number; costUsd: number } }) {
    this.projectPath = projectPath;
    this.timeoutMs = opts.timeoutMs;
    this.watchdogIntervalMs = opts.watchdogIntervalMs;

    if (opts.restore) {
      // Restore from DB — don't insert a new row
      this.id = opts.restore.id;
      this.sdkSessionId = opts.restore.sdkSessionId;
      this.startedAt = opts.restore.startedAt;
      this.lastActivityAt = this.startedAt;
      this.tokensUsed = opts.restore.tokensUsed;
      this.costUsd = opts.restore.costUsd;
      this.hasInitialized = true;
    } else {
      // Brand new session
      this.id = randomUUID();
      this.startedAt = new Date().toISOString();
      this.lastActivityAt = this.startedAt;

      const db = getDb();
      db.prepare(
        `INSERT INTO sessions (id, project_path, status, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)`
      ).run(this.id, projectPath, 'idle', this.startedAt, this.lastActivityAt);
    }
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

  /** Save user prompt to DB so it shows up in history on reload */
  saveUserPrompt(prompt: string, source?: string) {
    const db = getDb();
    db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?)`
    ).run(this.id, 'user', prompt, new Date().toISOString(), source ? JSON.stringify({ source }) : null);
  }

  async sendPrompt(prompt: string, opts?: { resume?: string; env?: Record<string, string> }): Promise<void> {
    if (this.status === 'running') {
      throw new Error('Session already running. Interrupt first.');
    }

    this.promptCount++;
    this.abortController = new AbortController();
    this.setStatus('running');
    this.lastEventTime = Date.now();
    this.startWatchdog();

    const envVars: Record<string, string | undefined> = { ...process.env, ...opts?.env };
    // Unset CLAUDECODE to allow SDK to spawn a subprocess when running inside a Claude Code session
    delete envVars['CLAUDECODE'];
    // Allow bypassPermissions when running as root (e.g. on VPS)
    envVars['IS_SANDBOX'] = '1';

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
          settingSources: ['user', 'project', 'local'],
          env: envVars,
          canUseTool: async (toolName, input, { signal }) => {
            // Auto-allow everything except AskUserQuestion
            if (toolName !== 'AskUserQuestion') {
              return { behavior: 'allow' as const };
            }

            const qInput = input as { questions: QuestionItem[] };
            const questions = qInput.questions ?? [];

            // Format as readable text
            let text = '';
            for (let i = 0; i < questions.length; i++) {
              const q = questions[i];
              text += `${q.question} [${q.header}]\n`;
              const letters = 'abcd';
              for (let j = 0; j < q.options.length; j++) {
                text += `  ${letters[j]}) ${q.options[j].label} — ${q.options[j].description}\n`;
              }
              text += `  ${letters[q.options.length]}) Other (type your own)\n`;
              if (i < questions.length - 1) text += '\n';
            }
            text += '\nReply with your choice (e.g. "a" or the option text)';

            this.emitChunk('question', text);

            // Keep watchdog alive while waiting for answer
            const keepAlive = setInterval(() => { this.lastEventTime = Date.now(); }, 5000);

            return new Promise<PermissionResult>((resolve) => {
              const timeout = setTimeout(() => {
                clearInterval(keepAlive);
                this.pendingQuestion = null;
                this.emitChunk('status', 'Question timed out — no answer received');
                resolve({ behavior: 'deny', message: 'No answer received (timeout)' });
              }, QUESTION_TIMEOUT_MS);

              signal.addEventListener('abort', () => {
                clearInterval(keepAlive);
                clearTimeout(timeout);
                this.pendingQuestion = null;
              });

              this.pendingQuestion = {
                questions,
                resolve: (answer: string) => {
                  clearInterval(keepAlive);
                  clearTimeout(timeout);
                  this.pendingQuestion = null;
                  const answers = this.parseAnswer(answer, questions);
                  resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
                },
              };
            });
          },
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

  hasPendingQuestion(): boolean {
    return this.pendingQuestion !== null;
  }

  answerQuestion(answer: string): boolean {
    if (!this.pendingQuestion) return false;
    this.pendingQuestion.resolve(answer);
    return true;
  }

  private parseAnswer(answer: string, questions: QuestionItem[]): Record<string, string> {
    const result: Record<string, string> = {};
    const trimmed = answer.trim().toLowerCase();

    for (const q of questions) {
      const letters = 'abcd';
      let matched = false;

      // Check letter match: "a", "b", "c", "d"
      for (let i = 0; i < q.options.length; i++) {
        if (trimmed === letters[i] || trimmed === `${letters[i]})`) {
          result[q.question] = q.options[i].label;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Check option label match (case-insensitive)
      for (const opt of q.options) {
        if (trimmed === opt.label.toLowerCase()) {
          result[q.question] = opt.label;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Treat as custom "Other" answer
      result[q.question] = answer.trim();
    }

    return result;
  }

  async interrupt(): Promise<void> {
    if (this.pendingQuestion) {
      this.pendingQuestion = null;
    }
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
          if (block.type === 'tool_use') {
            this.emitChunk('tool_use', JSON.stringify({ tool: block.name, input: block.input }));
          } else if (block.type === 'tool_result') {
            const result = block as any;
            const text = typeof result.content === 'string'
              ? result.content
              : Array.isArray(result.content)
                ? result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                : '';
            if (text) {
              this.emitChunk('tool_result', text.slice(0, 2000));
            }
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
        if (result.subtype !== 'success') {
          const sub = result.subtype as string;
          const reason = sub === 'error_during_execution'
            ? 'Claude crashed. Send a new message to continue.'
            : sub === 'interrupted'
            ? 'Stopped.'
            : `Session ended: ${sub}`;
          this.emitChunk('error', reason);
        }
        this.emitter.emit('ended', this.getInfo(), result.subtype);
        break;
      }
      case 'system': {
        if ('subtype' in message) {
          if (message.subtype === 'init') {
            // Only show init on the very first prompt, suppress on resume
            if (!this.hasInitialized) {
              this.hasInitialized = true;
              this.emitChunk('system', `Claude Code ${(message as any).claude_code_version}`);
            }
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

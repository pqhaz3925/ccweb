import { Session } from './session.js';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, CCWebConfig } from '../shared/types.js';
import { getDb } from './db.js';

export class SessionManager {
  private currentSession: Session | null = null;
  private currentProjectPath: string;
  readonly emitter = new TypedEmitter();
  private config: CCWebConfig['session'];
  private envOverrides: Record<string, string> = {};

  constructor(config: CCWebConfig) {
    this.config = config.session;
    this.currentProjectPath = config.session.defaultProject ?? process.cwd();

    if (config.claude.apiUrl) {
      this.envOverrides['ANTHROPIC_BASE_URL'] = config.claude.apiUrl;
    }
    if (config.claude.apiKey) {
      this.envOverrides['ANTHROPIC_API_KEY'] = config.claude.apiKey;
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!this.currentSession || this.currentSession.getInfo().status !== 'running') {
      this.currentSession = new Session(this.currentProjectPath, {
        timeoutMs: this.config.timeoutMs,
        watchdogIntervalMs: this.config.watchdogIntervalMs,
      });

      // Forward events
      this.currentSession.emitter.on('chunk', (chunk) => this.emitter.emit('chunk', chunk));
      this.currentSession.emitter.on('started', (info) => this.emitter.emit('started', info));
      this.currentSession.emitter.on('ended', (info, reason) => this.emitter.emit('ended', info, reason));
      this.currentSession.emitter.on('error', (err) => this.emitter.emit('error', err));
      this.currentSession.emitter.on('status_change', (info) => this.emitter.emit('status_change', info));
    }

    const resume = this.currentSession.getInfo().sdkSessionId ?? undefined;
    this.emitter.emit('started', this.currentSession.getInfo());
    await this.currentSession.sendPrompt(prompt, { resume, env: this.envOverrides });
  }

  async interrupt(): Promise<void> {
    if (this.currentSession) {
      await this.currentSession.interrupt();
    }
  }

  async restart(): Promise<void> {
    if (this.currentSession) {
      const oldSdkSessionId = this.currentSession.getInfo().sdkSessionId;
      await this.interrupt();

      this.currentSession = new Session(this.currentProjectPath, {
        timeoutMs: this.config.timeoutMs,
        watchdogIntervalMs: this.config.watchdogIntervalMs,
      });

      this.currentSession.emitter.on('chunk', (chunk) => this.emitter.emit('chunk', chunk));
      this.currentSession.emitter.on('started', (info) => this.emitter.emit('started', info));
      this.currentSession.emitter.on('ended', (info, reason) => this.emitter.emit('ended', info, reason));
      this.currentSession.emitter.on('error', (err) => this.emitter.emit('error', err));
      this.currentSession.emitter.on('status_change', (info) => this.emitter.emit('status_change', info));

      if (oldSdkSessionId) {
        await this.currentSession.sendPrompt('Continue from where we left off.', {
          resume: oldSdkSessionId,
          env: this.envOverrides,
        });
      }
    }
  }

  setProject(path: string) {
    this.currentProjectPath = path;
    this.currentSession = null;
  }

  getStatus(): { session: SessionInfo | null; projectPath: string } {
    return {
      session: this.currentSession?.getInfo() ?? null,
      projectPath: this.currentProjectPath,
    };
  }

  getHistory(limit = 20): SessionInfo[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_path,
      status: r.status,
      startedAt: r.started_at,
      lastActivityAt: r.last_activity_at,
      tokensUsed: r.tokens_used,
      costUsd: r.cost_usd,
      sdkSessionId: r.sdk_session_id,
    }));
  }
}

import { Session } from './session.js';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, CCWebConfig } from '../shared/types.js';
import { getDb } from './db.js';

const DEAD_STATES = new Set(['dead', 'error']);

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

  private createSession(): Session {
    const session = new Session(this.currentProjectPath, {
      timeoutMs: this.config.timeoutMs,
      watchdogIntervalMs: this.config.watchdogIntervalMs,
    });

    // Forward events
    session.emitter.on('chunk', (chunk) => this.emitter.emit('chunk', chunk));
    session.emitter.on('started', (info) => this.emitter.emit('started', info));
    session.emitter.on('ended', (info, reason) => this.emitter.emit('ended', info, reason));
    session.emitter.on('error', (err) => this.emitter.emit('error', err));
    session.emitter.on('status_change', (info) => this.emitter.emit('status_change', info));

    return session;
  }

  async sendPrompt(prompt: string): Promise<void> {
    // Only create a new session if there's none, or current one is dead/errored
    if (!this.currentSession || DEAD_STATES.has(this.currentSession.getInfo().status)) {
      this.currentSession = this.createSession();
    }

    if (this.currentSession.getInfo().status === 'running') {
      throw new Error('Session already running. Interrupt first.');
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

      this.currentSession = this.createSession();

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

  /** Get messages for the current session from SQLite */
  getMessages(limit = 200): Array<{ type: string; content: string; timestamp: string }> {
    if (!this.currentSession) return [];
    const db = getDb();
    const rows = db.prepare(
      `SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC LIMIT ?`
    ).all(this.currentSession.getInfo().id, limit) as any[];
    return rows.map((r: any) => ({
      type: r.role,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  getHistory(limit = 20): SessionInfo[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map((r: any) => ({
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

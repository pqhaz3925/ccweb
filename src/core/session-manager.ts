import { Session } from './session.js';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, CCWebConfig, StreamChunk } from '../shared/types.js';
import { getDb } from './db.js';

const DEAD_STATES = new Set(['dead', 'error']);

export interface SessionSummary {
  id: string;
  label: string;
  status: string;
  startedAt: string;
  tokensUsed: number;
  lastMessage: string;
}

export class SessionManager {
  private sessions = new Map<string, { session: Session; label: string }>();
  private activeSessionId: string | null = null;
  private currentProjectPath: string;
  readonly emitter = new TypedEmitter();
  private config: CCWebConfig['session'];
  private envOverrides: Record<string, string> = {};
  private sessionCounter = 0;

  constructor(config: CCWebConfig) {
    this.config = config.session;
    this.currentProjectPath = config.session.defaultProject ?? process.cwd();

    if (config.claude.apiUrl) {
      this.envOverrides['ANTHROPIC_BASE_URL'] = config.claude.apiUrl;
    }
    // API key: config > env var
    const apiKey = config.claude.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey) {
      this.envOverrides['ANTHROPIC_API_KEY'] = apiKey;
    }
  }

  private createSession(label?: string): Session {
    this.sessionCounter++;
    const session = new Session(this.currentProjectPath, {
      timeoutMs: this.config.timeoutMs,
      watchdogIntervalMs: this.config.watchdogIntervalMs,
    });

    const sessionLabel = label ?? `Chat ${this.sessionCounter}`;

    // Forward events only when this session is active
    session.emitter.on('chunk', (chunk) => {
      if (this.activeSessionId === session.id) {
        this.emitter.emit('chunk', chunk);
      }
    });
    session.emitter.on('started', (info) => {
      if (this.activeSessionId === session.id) {
        this.emitter.emit('started', info);
      }
    });
    session.emitter.on('ended', (info, reason) => {
      if (this.activeSessionId === session.id) {
        this.emitter.emit('ended', info, reason);
      }
    });
    session.emitter.on('error', (err) => {
      if (this.activeSessionId === session.id) {
        this.emitter.emit('error', err);
      }
    });
    session.emitter.on('status_change', (info) => {
      if (this.activeSessionId === session.id) {
        this.emitter.emit('status_change', info);
      }
    });

    this.sessions.set(session.id, { session, label: sessionLabel });
    return session;
  }

  /** Get or create the active session */
  private getOrCreateActive(): Session {
    if (this.activeSessionId) {
      const entry = this.sessions.get(this.activeSessionId);
      if (entry && !DEAD_STATES.has(entry.session.getInfo().status)) {
        return entry.session;
      }
    }
    // Create a new session and set it as active
    const session = this.createSession();
    this.activeSessionId = session.id;
    return session;
  }

  async sendPrompt(prompt: string, source?: string): Promise<void> {
    const session = this.getOrCreateActive();

    if (session.getInfo().status === 'running') {
      throw new Error('Session already running. Interrupt first.');
    }

    // Save user prompt with source tag so web knows about TG prompts
    session.saveUserPrompt(prompt, source);

    // Emit user prompt as a chunk so ALL connected transports see it live
    const userChunk: StreamChunk = {
      type: 'user' as any,
      content: prompt,
      timestamp: Date.now(),
      metadata: source ? { source } : undefined,
    };
    this.emitter.emit('chunk', userChunk);

    const resume = session.getInfo().sdkSessionId ?? undefined;
    this.emitter.emit('started', session.getInfo());
    await session.sendPrompt(prompt, { resume, env: this.envOverrides });
  }

  async interrupt(): Promise<void> {
    if (this.activeSessionId) {
      const entry = this.sessions.get(this.activeSessionId);
      if (entry) await entry.session.interrupt();
    }
  }

  async restart(): Promise<void> {
    if (this.activeSessionId) {
      const entry = this.sessions.get(this.activeSessionId);
      if (entry) {
        const oldSdkSessionId = entry.session.getInfo().sdkSessionId;
        await entry.session.interrupt();

        const newSession = this.createSession(entry.label);
        this.activeSessionId = newSession.id;
        // Remove old entry
        this.sessions.delete(entry.session.id);

        if (oldSdkSessionId) {
          await newSession.sendPrompt('Continue from where we left off.', {
            resume: oldSdkSessionId,
            env: this.envOverrides,
          });
        }
      }
    }
  }

  /** Create a brand-new session and switch to it */
  async newSession(label?: string): Promise<string> {
    // Don't interrupt old session — just create a new one and switch
    const session = this.createSession(label);
    this.activeSessionId = session.id;
    this.emitter.emit('status_change', session.getInfo());
    return session.id;
  }

  /** Switch active session by ID */
  switchSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.activeSessionId = sessionId;
    this.emitter.emit('status_change', entry.session.getInfo());
    return true;
  }

  /** List all sessions with summaries */
  listSessions(): SessionSummary[] {
    const db = getDb();
    const result: SessionSummary[] = [];

    for (const [id, entry] of this.sessions) {
      const info = entry.session.getInfo();
      // Get last user message for preview
      const lastMsg = db.prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`
      ).get(id) as { content: string } | undefined;

      result.push({
        id,
        label: entry.label,
        status: info.status,
        startedAt: info.startedAt,
        tokensUsed: info.tokensUsed,
        lastMessage: lastMsg?.content?.slice(0, 60) ?? '',
      });
    }

    return result;
  }

  /** Rewind last turn */
  async rewind(): Promise<void> {
    if (!this.activeSessionId) return;
    const entry = this.sessions.get(this.activeSessionId);
    if (!entry) return;
    const sdkSessionId = entry.session.getInfo().sdkSessionId;
    if (!sdkSessionId) return;

    await entry.session.interrupt();

    this.emitter.emit('started', entry.session.getInfo());
    await entry.session.sendPrompt(
      '/undo - Please undo your last action. Revert the last change you made.',
      { resume: sdkSessionId, env: this.envOverrides }
    );
  }

  setProject(path: string) {
    this.currentProjectPath = path;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getStatus(): { session: SessionInfo | null; projectPath: string } {
    if (this.activeSessionId) {
      const entry = this.sessions.get(this.activeSessionId);
      if (entry) {
        return { session: entry.session.getInfo(), projectPath: this.currentProjectPath };
      }
    }
    return { session: null, projectPath: this.currentProjectPath };
  }

  /** Get messages for a specific session (or active) */
  getMessages(sessionId?: string, limit = 200): Array<{ type: string; content: string; timestamp: string }> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return [];
    const db = getDb();
    const rows = db.prepare(
      `SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC LIMIT ?`
    ).all(id, limit) as any[];
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

import { Session } from './session.js';
import { TypedEmitter } from '../shared/events.js';
import type { SessionInfo, CCWebConfig, StreamChunk } from '../shared/types.js';
import { getDb } from './db.js';

const DEAD_STATES = new Set(['dead']);
const DEFAULT_USER = 'default';

export interface SessionSummary {
  id: string;
  label: string;
  status: string;
  startedAt: string;
  tokensUsed: number;
  lastMessage: string;
  chatNumber: number;
}

interface SessionEntry { session: Session; label: string; autoLabel: boolean; chatNumber: number }

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  /** Maps userId → active sessionId */
  private activeByUser = new Map<string, string>();
  private currentProjectPath: string;
  readonly emitter = new TypedEmitter();
  private config: CCWebConfig['session'];
  private envOverrides: Record<string, string> = {};
  private executablePath: string | null = null;
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
    this.executablePath = config.claude.executablePath;

    // Restore recent sessions from DB so history survives restarts
    this.restoreFromDb();
  }

  /** Reload all sessions from DB so conversations survive restarts */
  private restoreFromDb() {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, project_path, started_at, tokens_used, cost_usd, sdk_session_id, chat_number, label, auto_label
       FROM sessions WHERE sdk_session_id IS NOT NULL
       ORDER BY COALESCE(chat_number, 0) ASC, last_activity_at ASC`
    ).all() as any[];

    if (rows.length === 0) return;

    // Backfill chat_number for any old session that doesn't have one yet so
    // numbers stay stable from now on.
    const maxRow = db.prepare(`SELECT COALESCE(MAX(chat_number), 0) AS m FROM sessions`).get() as { m: number };
    let nextNum = (maxRow?.m ?? 0) + 1;
    const setChatNumber = db.prepare(`UPDATE sessions SET chat_number = ? WHERE id = ?`);

    for (const row of rows) {
      let chatNumber: number = row.chat_number ?? 0;
      if (!chatNumber) {
        chatNumber = nextNum++;
        setChatNumber.run(chatNumber, row.id);
      }
      if (chatNumber > this.sessionCounter) this.sessionCounter = chatNumber;

      const session = new Session(row.project_path, {
        timeoutMs: this.config.timeoutMs,
        watchdogIntervalMs: this.config.watchdogIntervalMs,
        restore: {
          id: row.id,
          sdkSessionId: row.sdk_session_id,
          startedAt: row.started_at,
          tokensUsed: row.tokens_used ?? 0,
          costUsd: row.cost_usd ?? 0,
        },
      });

      const label: string = row.label ?? `Chat ${chatNumber}`;
      const autoLabel: boolean = row.auto_label === undefined ? !row.label : !!row.auto_label;
      this.wireSessionEvents(session);
      this.sessions.set(session.id, { session, label, autoLabel, chatNumber });
      // Last restored session becomes active for default user
      this.activeByUser.set(DEFAULT_USER, session.id);
    }

    console.log(`[sessions] Restored ${rows.length} sessions`);
  }

  private nextChatNumber(): number {
    const db = getDb();
    const row = db.prepare(`SELECT COALESCE(MAX(chat_number), 0) AS m FROM sessions`).get() as { m: number };
    const n = (row?.m ?? 0) + 1;
    if (n > this.sessionCounter) this.sessionCounter = n;
    return n;
  }

  private persistChatMeta(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    getDb().prepare(
      `UPDATE sessions SET chat_number = ?, label = ?, auto_label = ? WHERE id = ?`
    ).run(entry.chatNumber, entry.label, entry.autoLabel ? 1 : 0, sessionId);
  }

  /** Wire up event forwarding — always emit, include sessionId */
  private wireSessionEvents(session: Session) {
    session.emitter.on('chunk', (chunk: StreamChunk) => {
      this.emitter.emit('chunk', chunk, session.id);
    });
    session.emitter.on('started', (info: SessionInfo) => {
      this.emitter.emit('started', info);
    });
    session.emitter.on('ended', (info: SessionInfo, reason: string) => {
      this.emitter.emit('ended', info, reason);
    });
    session.emitter.on('error', (err: Error) => {
      this.emitter.emit('error', err, session.id);
    });
    session.emitter.on('status_change', (info: SessionInfo) => {
      this.emitter.emit('status_change', info);
    });
  }

  private createSession(label?: string): Session {
    const chatNumber = this.nextChatNumber();
    const session = new Session(this.currentProjectPath, {
      timeoutMs: this.config.timeoutMs,
      watchdogIntervalMs: this.config.watchdogIntervalMs,
    });

    const sessionLabel = label ?? `Chat ${chatNumber}`;
    const autoLabel = !label;
    this.wireSessionEvents(session);
    this.sessions.set(session.id, { session, label: sessionLabel, autoLabel, chatNumber });
    this.persistChatMeta(session.id);
    return session;
  }

  /** Set a custom label for a chat (also marks it non-auto so it won't be overwritten). */
  setLabel(sessionId: string, label: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.label = label.slice(0, 60);
    entry.autoLabel = false;
    this.persistChatMeta(sessionId);
    return true;
  }

  /** Auto-generate a label from the first user prompt if the chat still has the default label. */
  private maybeAutoLabel(sessionId: string, prompt: string) {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.autoLabel) return;
    const cleaned = prompt.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    entry.label = cleaned.slice(0, 50);
    entry.autoLabel = false;
    this.persistChatMeta(sessionId);
  }

  /** Get chat label and stable chat number (persisted, never shifts). */
  getChatMeta(sessionId: string): { label: string; index: number } | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return { label: entry.label, index: entry.chatNumber };
  }

  /** Get or create the active session for a user */
  private getOrCreateActive(userId: string = DEFAULT_USER): Session {
    const activeId = this.activeByUser.get(userId);
    if (activeId) {
      const entry = this.sessions.get(activeId);
      const status = entry?.session.getInfo().status;
      if (entry && !DEAD_STATES.has(status!)) {
        return entry.session;
      }
      console.log(`[sessions] Session ${activeId} for user ${userId} is ${status ?? 'missing'}, creating new`);
    }
    // Create a new session and set it as active for this user
    const session = this.createSession();
    this.activeByUser.set(userId, session.id);
    return session;
  }

  /** Check if the user's active session has a pending question */
  hasPendingQuestion(userId: string = DEFAULT_USER): boolean {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return false;
    const entry = this.sessions.get(activeId);
    return entry?.session.hasPendingQuestion() ?? false;
  }

  /** Answer a pending question in the user's active session */
  answerQuestion(answer: string, userId: string = DEFAULT_USER): boolean {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return false;
    const entry = this.sessions.get(activeId);
    if (!entry) return false;
    return entry.session.answerQuestion(answer);
  }

  /** Send a prompt to a specific session (used for reply-routing). Does not change active session. */
  async sendPromptToSession(sessionId: string, prompt: string, source?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Chat not found');
    const session = entry.session;

    // If a question is pending in this session, the next message answers it
    if (session.hasPendingQuestion()) {
      const userChunk: StreamChunk = {
        type: 'user' as any,
        content: prompt,
        timestamp: Date.now(),
        metadata: source ? { source } : undefined,
      };
      this.emitter.emit('chunk', userChunk, session.id);
      session.answerQuestion(prompt);
      return;
    }

    // If the session is currently running, inject as a steer message into the active SDK turn
    if (session.getInfo().status === 'running') {
      session.saveUserPrompt(prompt, source);
      const userChunk: StreamChunk = {
        type: 'user' as any,
        content: prompt,
        timestamp: Date.now(),
        metadata: source ? { source } : undefined,
      };
      this.emitter.emit('chunk', userChunk, session.id);
      const ok = session.steer(prompt);
      if (!ok) throw new Error('Could not steer running chat');
      return;
    }

    // Otherwise behave like a normal sendPrompt scoped to this session
    this.maybeAutoLabel(session.id, prompt);
    session.saveUserPrompt(prompt, source);
    const userChunk: StreamChunk = {
      type: 'user' as any,
      content: prompt,
      timestamp: Date.now(),
      metadata: source ? { source } : undefined,
    };
    this.emitter.emit('chunk', userChunk, session.id);

    const resume = session.getInfo().sdkSessionId ?? undefined;
    this.emitter.emit('started', session.getInfo());
    await session.sendPrompt(prompt, { resume, env: this.envOverrides, executablePath: this.executablePath ?? undefined });
  }

  async sendPrompt(prompt: string, source?: string, userId: string = DEFAULT_USER): Promise<void> {
    // If there's a pending question, route the answer instead of starting a new prompt
    if (this.hasPendingQuestion(userId)) {
      const userChunk: StreamChunk = {
        type: 'user' as any,
        content: prompt,
        timestamp: Date.now(),
        metadata: source ? { source } : undefined,
      };
      const activeId = this.activeByUser.get(userId)!;
      this.emitter.emit('chunk', userChunk, activeId);
      this.answerQuestion(prompt, userId);
      return;
    }

    const session = this.getOrCreateActive(userId);
    // Delegate so running sessions get steered (mid-stream injection) instead of erroring out
    await this.sendPromptToSession(session.id, prompt, source);
  }

  async interrupt(userId: string = DEFAULT_USER): Promise<void> {
    const activeId = this.activeByUser.get(userId);
    if (activeId) {
      const entry = this.sessions.get(activeId);
      if (entry) await entry.session.interrupt();
    }
  }

  async restart(userId: string = DEFAULT_USER): Promise<void> {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return;
    const entry = this.sessions.get(activeId);
    if (!entry) return;

    const oldSdkSessionId = entry.session.getInfo().sdkSessionId;
    await entry.session.interrupt();

    const newSession = this.createSession(entry.label);
    this.activeByUser.set(userId, newSession.id);
    // Remove old entry
    this.sessions.delete(entry.session.id);

    if (oldSdkSessionId) {
      await newSession.sendPrompt('Continue from where we left off.', {
        resume: oldSdkSessionId,
        env: this.envOverrides,
        executablePath: this.executablePath ?? undefined,
      });
    }
  }

  /** Create a brand-new session and switch to it for the given user */
  async newSession(label?: string, userId: string = DEFAULT_USER): Promise<string> {
    const session = this.createSession(label);
    this.activeByUser.set(userId, session.id);
    this.emitter.emit('status_change', session.getInfo());
    return session.id;
  }

  /** Switch active session by ID for the given user */
  switchSession(sessionId: string, userId: string = DEFAULT_USER): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.activeByUser.set(userId, sessionId);
    this.emitter.emit('status_change', entry.session.getInfo());
    return true;
  }

  /** List all sessions with summaries */
  listSessions(): SessionSummary[] {
    const db = getDb();
    const result: SessionSummary[] = [];

    for (const [id, entry] of this.sessions) {
      const info = entry.session.getInfo();
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
        chatNumber: entry.chatNumber,
      });
    }

    return result.sort((a, b) => a.chatNumber - b.chatNumber);
  }

  /** Rewind last turn */
  async rewind(userId: string = DEFAULT_USER): Promise<void> {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return;
    const entry = this.sessions.get(activeId);
    if (!entry) return;
    const sdkSessionId = entry.session.getInfo().sdkSessionId;
    if (!sdkSessionId) return;

    await entry.session.interrupt();

    this.emitter.emit('started', entry.session.getInfo());
    await entry.session.sendPrompt(
      '/undo - Please undo your last action. Revert the last change you made.',
      { resume: sdkSessionId, env: this.envOverrides, executablePath: this.executablePath ?? undefined }
    );
  }

  async compact(userId: string = DEFAULT_USER): Promise<void> {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return;
    const entry = this.sessions.get(activeId);
    if (!entry) return;
    const sdkSessionId = entry.session.getInfo().sdkSessionId;
    if (!sdkSessionId) return;

    await entry.session.interrupt();

    this.emitter.emit('started', entry.session.getInfo());
    await entry.session.sendPrompt(
      '/compact',
      { resume: sdkSessionId, env: this.envOverrides, executablePath: this.executablePath ?? undefined }
    );
  }

  setProject(path: string) {
    this.currentProjectPath = path;
  }

  setModel(model: string) {
    this.envOverrides['ANTHROPIC_MODEL'] = model;
  }

  getModel(): string {
    return this.envOverrides['ANTHROPIC_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? 'default';
  }

  setEffort(level: string) {
    this.envOverrides['CLAUDE_CODE_EFFORT_LEVEL'] = level;
  }

  getEffort(): string {
    return this.envOverrides['CLAUDE_CODE_EFFORT_LEVEL'] ?? process.env['CLAUDE_CODE_EFFORT_LEVEL'] ?? 'default';
  }

  getActiveSessionId(userId: string = DEFAULT_USER): string | null {
    return this.activeByUser.get(userId) ?? null;
  }

  /** Find which userId owns a given sessionId */
  findUserBySession(sessionId: string): string | null {
    for (const [userId, sid] of this.activeByUser) {
      if (sid === sessionId) return userId;
    }
    return null;
  }

  getStatus(userId: string = DEFAULT_USER): { session: SessionInfo | null; projectPath: string } {
    const activeId = this.activeByUser.get(userId);
    if (activeId) {
      const entry = this.sessions.get(activeId);
      if (entry) {
        return { session: entry.session.getInfo(), projectPath: this.currentProjectPath };
      }
    }
    return { session: null, projectPath: this.currentProjectPath };
  }

  /** Get messages for a specific session (or user's active) */
  getMessages(sessionId?: string, userId: string = DEFAULT_USER, limit = 200): Array<{ type: string; content: string; timestamp: string }> {
    const id = sessionId ?? this.activeByUser.get(userId);
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

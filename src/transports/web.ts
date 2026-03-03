import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SessionManager } from '../core/session-manager.js';
import type { ClientMessage, ServerMessage, StreamChunk, SessionInfo, SessionSummaryWire } from '../shared/types.js';
import {
  getMcpStatus, togglePlugin, setGlobalMcpServer,
  getSkills, getMemory, saveMemoryFile,
  getPermissionMode, setPermissionMode,
  type PermissionMode,
} from '../core/mcp-manager.js';

function buildSessionsList(sm: SessionManager): { sessions: SessionSummaryWire[]; activeId: string | null } {
  const activeId = sm.getActiveSessionId();
  const sessions = sm.listSessions().map((s) => ({
    ...s,
    active: s.id === activeId,
  }));
  return { sessions, activeId };
}

export async function startWebServer(sessionManager: SessionManager, port: number, host: string) {
  const fastify = Fastify({ logger: false });

  await fastify.register(fastifyWebsocket);

  // Serve built React PWA if available
  const webDist = resolve(process.cwd(), 'web', 'dist');
  if (existsSync(webDist)) {
    await fastify.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
  }

  // Health check
  fastify.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));

  // Status endpoint
  fastify.get('/api/status', async () => sessionManager.getStatus());

  // History endpoint
  fastify.get('/api/history', async () => sessionManager.getHistory());

  // Messages for current session (for reconnect/reload)
  fastify.get('/api/messages', async () => sessionManager.getMessages());

  // Sessions list
  fastify.get('/api/sessions', async () => buildSessionsList(sessionManager));

  // MCP / Plugins
  fastify.get('/api/mcp', async () => {
    const projectPath = sessionManager.getStatus().projectPath;
    return getMcpStatus(projectPath);
  });

  fastify.post('/api/mcp/toggle-plugin', async (req) => {
    const { pluginId, enabled } = req.body as { pluginId: string; enabled: boolean };
    togglePlugin(pluginId, enabled);
    return { ok: true };
  });

  fastify.post('/api/mcp/server', async (req) => {
    const { name, config } = req.body as { name: string; config: any };
    setGlobalMcpServer(name, config ?? null);
    return { ok: true };
  });

  // Skills
  fastify.get('/api/skills', async () => {
    const projectPath = sessionManager.getStatus().projectPath;
    return getSkills(projectPath);
  });

  // Memory / CLAUDE.md
  fastify.get('/api/memory', async () => {
    const projectPath = sessionManager.getStatus().projectPath;
    return getMemory(projectPath);
  });

  fastify.post('/api/memory', async (req) => {
    const { fileKey, content } = req.body as { fileKey: string; content: string };
    const projectPath = sessionManager.getStatus().projectPath;
    saveMemoryFile(projectPath, fileKey, content);
    return { ok: true };
  });

  // Permissions
  fastify.get('/api/permissions', async () => {
    return { mode: getPermissionMode() };
  });

  fastify.post('/api/permissions', async (req) => {
    const { mode } = req.body as { mode: PermissionMode };
    setPermissionMode(mode);
    return { ok: true };
  });

  // WebSocket for real-time streaming
  fastify.get('/ws', { websocket: true }, (socket) => {
    console.log('[web] Client connected');

    const send = (msg: ServerMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Send initial state
    send({ type: 'connected', version: '0.1.0' });
    const status = sessionManager.getStatus();
    send({ type: 'status', session: status.session, project: null });

    // Send sessions list
    const sl = buildSessionsList(sessionManager);
    send({ type: 'sessions_list', sessions: sl.sessions, activeId: sl.activeId });

    // Send existing messages so client can restore history on reconnect
    const existingMessages = sessionManager.getMessages();
    if (existingMessages.length > 0) {
      send({ type: 'history', messages: existingMessages });
    }

    // Subscribe to session events
    const onChunk = (chunk: StreamChunk) => send({ type: 'chunk', chunk });
    const onStarted = (session: SessionInfo) => send({ type: 'session_started', session });
    const onEnded = (session: SessionInfo, reason: string) => send({ type: 'session_ended', session, reason });
    const onError = (err: Error) => send({ type: 'session_error', error: err.message });
    const onStatusChange = (session: SessionInfo) => send({ type: 'status', session, project: null });

    sessionManager.emitter.on('chunk', onChunk);
    sessionManager.emitter.on('started', onStarted);
    sessionManager.emitter.on('ended', onEnded);
    sessionManager.emitter.on('error', onError);
    sessionManager.emitter.on('status_change', onStatusChange);

    // Handle client messages
    socket.on('message', async (data: Buffer | string) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());

        switch (msg.type) {
          case 'send_prompt':
            if (msg.projectPath) sessionManager.setProject(msg.projectPath);
            sessionManager.sendPrompt(msg.prompt, 'web').catch((err) => {
              send({ type: 'session_error', error: err.message });
            });
            break;
          case 'interrupt':
            await sessionManager.interrupt();
            break;
          case 'restart':
            await sessionManager.restart();
            break;
          case 'new_session': {
            await sessionManager.newSession(msg.label);
            const sl2 = buildSessionsList(sessionManager);
            send({ type: 'sessions_list', sessions: sl2.sessions, activeId: sl2.activeId });
            // Send empty history for the new session
            send({ type: 'history', messages: [] });
            break;
          }
          case 'switch_session': {
            const ok = sessionManager.switchSession(msg.sessionId);
            if (ok) {
              const sl3 = buildSessionsList(sessionManager);
              send({ type: 'sessions_list', sessions: sl3.sessions, activeId: sl3.activeId });
              // Send messages for the switched-to session
              const msgs = sessionManager.getMessages(msg.sessionId);
              send({ type: 'history', messages: msgs });
            } else {
              send({ type: 'session_error', error: 'Session not found' });
            }
            break;
          }
          case 'list_sessions': {
            const sl4 = buildSessionsList(sessionManager);
            send({ type: 'sessions_list', sessions: sl4.sessions, activeId: sl4.activeId });
            break;
          }
          case 'rewind':
            sessionManager.rewind().catch((err) => {
              send({ type: 'session_error', error: err.message });
            });
            break;
          case 'status': {
            const s = sessionManager.getStatus();
            send({ type: 'status', session: s.session, project: null });
            break;
          }
          case 'set_project':
            sessionManager.setProject(msg.path);
            break;
        }
      } catch (_err) {
        send({ type: 'session_error', error: 'Invalid message format' });
      }
    });

    socket.on('close', () => {
      console.log('[web] Client disconnected');
      sessionManager.emitter.off('chunk', onChunk);
      sessionManager.emitter.off('started', onStarted);
      sessionManager.emitter.off('ended', onEnded);
      sessionManager.emitter.off('error', onError);
      sessionManager.emitter.off('status_change', onStatusChange);
    });
  });

  await fastify.listen({ port, host });
  console.log(`[web] Server running at http://${host}:${port}`);
  return fastify;
}

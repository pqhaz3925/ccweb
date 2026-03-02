import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SessionManager } from '../core/session-manager.js';
import type { ClientMessage, ServerMessage, StreamChunk, SessionInfo } from '../shared/types.js';

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

    // Send existing messages so client can restore history on reconnect
    const existingMessages = sessionManager.getMessages();
    if (existingMessages.length > 0) {
      send({ type: 'history', messages: existingMessages } as any);
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
            sessionManager.sendPrompt(msg.prompt).catch((err) => {
              send({ type: 'session_error', error: err.message });
            });
            break;
          case 'interrupt':
            await sessionManager.interrupt();
            break;
          case 'restart':
            await sessionManager.restart();
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

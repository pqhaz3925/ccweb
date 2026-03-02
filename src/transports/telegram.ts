import { Bot } from 'grammy';
import type { SessionManager } from '../core/session-manager.js';
import type { StreamChunk } from '../shared/types.js';

const MAX_MSG_LENGTH = 4000; // Leave margin for formatting
const FLUSH_INTERVAL_MS = 2500; // Respect ~20 edits/min limit

export async function startTelegramBot(
  sessionManager: SessionManager,
  token: string,
  allowedUsers: number[]
) {
  const bot = new Bot(token);

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || (allowedUsers.length > 0 && !allowedUsers.includes(userId))) {
      await ctx.reply('Unauthorized.');
      return;
    }
    await next();
  });

  // State per chat for streaming output
  const chatState = new Map<number, {
    messageId: number | null;
    buffer: string;
    flushTimer: ReturnType<typeof setInterval> | null;
    fullText: string;
  }>();

  function getChatState(chatId: number) {
    if (!chatState.has(chatId)) {
      chatState.set(chatId, { messageId: null, buffer: '', flushTimer: null, fullText: '' });
    }
    return chatState.get(chatId)!;
  }

  async function flushBuffer(chatId: number) {
    const state = getChatState(chatId);
    if (!state.buffer && !state.fullText) return;

    const textToSend = state.fullText + state.buffer;
    state.fullText = textToSend;
    state.buffer = '';

    // Trim to last MAX_MSG_LENGTH chars for the current message
    const displayText = textToSend.length > MAX_MSG_LENGTH
      ? '...' + textToSend.slice(-MAX_MSG_LENGTH + 3)
      : textToSend;

    try {
      if (state.messageId) {
        await bot.api.editMessageText(chatId, state.messageId, displayText || '...');
      } else {
        const msg = await bot.api.sendMessage(chatId, displayText || 'Processing...');
        state.messageId = msg.message_id;
      }
    } catch (err: unknown) {
      // Handle "message is not modified" error silently
      const errMsg = err instanceof Error ? err.message : '';
      if (!errMsg.includes('not modified')) {
        console.error('[telegram] Flush error:', errMsg);
      }
    }
  }

  function startStreaming(chatId: number) {
    const state = getChatState(chatId);
    state.messageId = null;
    state.buffer = '';
    state.fullText = '';

    if (state.flushTimer) clearInterval(state.flushTimer);
    state.flushTimer = setInterval(() => flushBuffer(chatId), FLUSH_INTERVAL_MS);
  }

  function stopStreaming(chatId: number) {
    const state = getChatState(chatId);
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
    // Final flush
    flushBuffer(chatId);
  }

  function appendChunk(chatId: number, chunk: StreamChunk) {
    const state = getChatState(chatId);
    const stripped = stripAnsi(chunk.content);

    switch (chunk.type) {
      case 'text':
        state.buffer += stripped;
        break;
      case 'tool_use':
        try {
          const parsed = JSON.parse(stripped);
          state.buffer += `\n🔧 ${parsed.tool}\n`;
        } catch {
          state.buffer += `\n🔧 Tool call\n`;
        }
        break;
      case 'status':
        state.buffer += `\n⏳ ${stripped}\n`;
        break;
      case 'error':
        state.buffer += `\n❌ ${stripped}\n`;
        break;
      case 'result':
        state.buffer += `\n✅ Done\n`;
        break;
    }
  }

  // Track which chat is currently active for streaming
  let activeChatId: number | null = null;

  // Subscribe to session manager events
  sessionManager.emitter.on('chunk', (chunk) => {
    if (activeChatId) appendChunk(activeChatId, chunk);
  });

  sessionManager.emitter.on('ended', (session, reason) => {
    if (activeChatId) {
      const state = getChatState(activeChatId);
      state.buffer += `\n\n📊 ${session.tokensUsed} tokens | $${session.costUsd.toFixed(4)} | ${reason}`;
      stopStreaming(activeChatId);
    }
  });

  sessionManager.emitter.on('error', (err) => {
    if (activeChatId) {
      const state = getChatState(activeChatId);
      state.buffer += `\n❌ Error: ${err.message}`;
      stopStreaming(activeChatId);
    }
  });

  // Commands
  bot.command('start', (ctx) => ctx.reply(
    'CCWeb Telegram Bot\n\n' +
    'Send any message to prompt Claude Code.\n\n' +
    'Commands:\n' +
    '/stop - Stop current session\n' +
    '/restart - Restart session\n' +
    '/status - Current status\n' +
    '/project <path> - Switch project\n' +
    '/history - Recent sessions'
  ));

  bot.command('stop', async (ctx) => {
    await sessionManager.interrupt();
    if (activeChatId) stopStreaming(activeChatId);
    await ctx.reply('⏹ Session stopped.');
  });

  bot.command('restart', async (ctx) => {
    activeChatId = ctx.chat.id;
    startStreaming(ctx.chat.id);
    await sessionManager.restart();
  });

  bot.command('status', async (ctx) => {
    const { session, projectPath } = sessionManager.getStatus();
    if (session && session.status === 'running') {
      await ctx.reply(
        `🟢 Running\n📁 ${projectPath}\n📊 ${session.tokensUsed} tokens | $${session.costUsd.toFixed(4)}`
      );
    } else {
      await ctx.reply(`💤 Idle\n📁 ${projectPath}`);
    }
  });

  bot.command('project', async (ctx) => {
    const path = ctx.match?.trim();
    if (!path) {
      await ctx.reply('Usage: /project <path>');
      return;
    }
    sessionManager.setProject(path);
    await ctx.reply(`📁 Project set to: ${path}`);
  });

  bot.command('history', async (ctx) => {
    const sessions = sessionManager.getHistory(5);
    if (sessions.length === 0) {
      await ctx.reply('No sessions yet.');
      return;
    }
    const lines = sessions.map((s, i) =>
      `${i + 1}. ${s.status === 'running' ? '🟢' : '⚪'} ${s.startedAt.slice(0, 16)} | ${s.tokensUsed} tokens | $${s.costUsd.toFixed(4)}`
    );
    await ctx.reply(lines.join('\n'));
  });

  // Plain text = send prompt
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Skip unknown commands

    activeChatId = ctx.chat.id;
    startStreaming(ctx.chat.id);

    try {
      await sessionManager.sendPrompt(text);
    } catch (err) {
      const state = getChatState(ctx.chat.id);
      state.buffer += `\n❌ ${err instanceof Error ? err.message : 'Unknown error'}`;
      stopStreaming(ctx.chat.id);
    }
  });

  bot.start();
  console.log('[telegram] Bot started');
  return bot;
}

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

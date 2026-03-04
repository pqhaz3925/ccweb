import { Bot } from 'grammy';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../core/session-manager.js';
import type { CCWebConfig, StreamChunk } from '../shared/types.js';

const EDIT_INTERVAL_MS = 2000;
const TYPING_INTERVAL_MS = 4000;

/**
 * Convert Claude markdown output to Telegram HTML.
 */
function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escapedCode = escapeHtml(code.replace(/\n$/, ''));
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escapedCode}</code></pre>`
        : `<pre>${escapedCode}</pre>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  result = escapeHtml(result);

  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCode[parseInt(idx)]);

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripAnsi(str: string): string {
  return str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
}

function isGroup(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

export async function startTelegramBot(
  sessionManager: SessionManager,
  telegramConfig: CCWebConfig['telegram']
) {
  const { token, allowedUsers, allowedGroups } = telegramConfig;
  if (!token) throw new Error('Telegram token is required');

  const bot = new Bot(token);

  const me = await bot.api.getMe();
  const botUsername = me.username;
  console.log(`[telegram] Bot username: @${botUsername}`);

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const chatType = ctx.chat?.type;
    if (!chatType) return;

    if (isGroup(chatType)) {
      const chatId = ctx.chat!.id;
      if (allowedGroups.length === 0 || !allowedGroups.includes(chatId)) {
        return;
      }
    } else {
      if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        await ctx.reply('Unauthorized.');
        return;
      }
    }

    await next();
  });

  // --- State per chat ---

  const chatState = new Map<
    number,
    {
      buffer: string;
      sentText: string;
      messageId: number | null;
      flushTimer: ReturnType<typeof setInterval> | null;
      typingTimer: ReturnType<typeof setInterval> | null;
      lastToolFull: string | null;
      lastToolShort: string | null;
      quiet: boolean;
    }
  >();

  function getChatState(chatId: number) {
    if (!chatState.has(chatId)) {
      chatState.set(chatId, {
        buffer: '',
        sentText: '',
        messageId: null,
        flushTimer: null,
        typingTimer: null,
        lastToolFull: null,
        lastToolShort: null,
        quiet: false,
      });
    }
    return chatState.get(chatId)!;
  }

  function trimLastToolResult(chatId: number) {
    const state = getChatState(chatId);
    if (!state.lastToolFull || !state.lastToolShort) return;
    if (state.lastToolFull === state.lastToolShort) {
      state.lastToolFull = null;
      state.lastToolShort = null;
      return;
    }

    if (state.buffer.includes(state.lastToolFull)) {
      state.buffer = state.buffer.replace(state.lastToolFull, state.lastToolShort);
    } else if (state.sentText.includes(state.lastToolFull)) {
      state.sentText = state.sentText.replace(state.lastToolFull, state.lastToolShort);
    }
    state.lastToolFull = null;
    state.lastToolShort = null;
  }

  // --- Typing indicator ---

  function startTyping(chatId: number) {
    const state = getChatState(chatId);
    bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    if (state.typingTimer) clearInterval(state.typingTimer);
    state.typingTimer = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  function stopTyping(chatId: number) {
    const state = getChatState(chatId);
    if (state.typingTimer) {
      clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
  }

  // --- Send / Edit helpers ---

  async function editOrSend(
    chatId: number,
    text: string,
    messageId: number | null
  ): Promise<number | null> {
    const html = markdownToTelegramHtml(text);

    if (messageId) {
      try {
        await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
        return messageId;
      } catch {
        try {
          await bot.api.editMessageText(chatId, messageId, text);
          return messageId;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : '';
          if (!msg.includes('not modified')) {
            console.error('[telegram] Edit error:', msg);
          }
          return messageId;
        }
      }
    } else {
      try {
        const result = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
        return result.message_id;
      } catch {
        try {
          const result = await bot.api.sendMessage(chatId, text);
          return result.message_id;
        } catch (e: unknown) {
          console.error('[telegram] Send error:', e instanceof Error ? e.message : '');
          return null;
        }
      }
    }
  }

  async function sendLongMessage(chatId: number, text: string, html?: string) {
    const TG_LIMIT = 4096;
    const content = html || text;
    const fallback = html ? text : null;

    if (content.length <= TG_LIMIT) {
      try {
        await bot.api.sendMessage(chatId, content, html ? { parse_mode: 'HTML' } : {});
        return;
      } catch {
        if (fallback && fallback.length <= TG_LIMIT) {
          try { await bot.api.sendMessage(chatId, fallback); return; } catch {}
        }
      }
    }

    const source = text;
    for (let i = 0; i < source.length; i += TG_LIMIT) {
      const chunk = source.slice(i, i + TG_LIMIT);
      try {
        await bot.api.sendMessage(chatId, chunk);
      } catch (e: unknown) {
        console.error('[telegram] Chunk send error:', e instanceof Error ? e.message : '');
      }
    }
  }

  // --- Streaming: send message, edit as text grows, new msg on limit ---

  async function flushEdit(chatId: number) {
    const state = getChatState(chatId);
    if (!state.buffer.trim()) return;

    const newContent = state.buffer;
    state.buffer = '';

    const combined = state.sentText + newContent;

    if (combined.length <= 4000) {
      state.messageId = await editOrSend(chatId, combined, state.messageId);
      state.sentText = combined;
    } else {
      // Current message hit limit — start a new one
      state.messageId = null;
      state.sentText = '';

      if (newContent.length <= 4000) {
        state.messageId = await editOrSend(chatId, newContent, null);
        state.sentText = newContent;
      } else {
        await sendLongMessage(chatId, newContent, markdownToTelegramHtml(newContent));
      }
    }
  }

  async function finalizeMessage(chatId: number) {
    await flushEdit(chatId);
    const state = getChatState(chatId);
    state.messageId = null;
    state.sentText = '';
  }

  function startStreaming(chatId: number) {
    const state = getChatState(chatId);
    state.buffer = '';
    state.sentText = '';
    state.messageId = null;

    startTyping(chatId);

    if (state.flushTimer) clearInterval(state.flushTimer);
    state.flushTimer = setInterval(() => {
      flushEdit(chatId).catch(() => {});
    }, EDIT_INTERVAL_MS);
  }

  function stopStreaming(chatId: number) {
    const state = getChatState(chatId);
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
    stopTyping(chatId);
    finalizeMessage(chatId).catch(() => {});
  }

  // --- Tool formatting ---

  function formatToolUse(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      const tool = parsed.tool ?? 'Tool';
      const input = parsed.input;
      if (!input) return `> ${tool}`;

      switch (tool) {
        case 'Bash': {
          const cmd = input.command ?? '';
          const short = cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
          return `> $ ${short}`;
        }
        case 'Read':
          return `> Read ${input.file_path ?? ''}`;
        case 'Edit':
          return `> Edit ${input.file_path ?? ''}`;
        case 'Write':
          return `> Write ${input.file_path ?? ''}`;
        case 'Glob':
          return `> Glob ${input.pattern ?? ''}`;
        case 'Grep':
          return `> Grep "${input.pattern ?? ''}"`;
        case 'Task':
          return `> Task: ${input.description ?? input.prompt?.slice(0, 60) ?? ''}`;
        case 'TodoWrite':
          return '';
        case 'WebFetch':
          return `> Fetch ${input.url ?? ''}`;
        case 'WebSearch':
          return `> Search "${input.query ?? ''}"`;
        default:
          return `> ${tool}`;
      }
    } catch {
      return '> Tool call';
    }
  }

  // --- Chunk handling ---

  function appendChunk(chatId: number, chunk: StreamChunk) {
    const state = getChatState(chatId);
    const stripped = stripAnsi(chunk.content);

    switch (chunk.type) {
      case 'text':
        trimLastToolResult(chatId);
        state.buffer += stripped;
        break;
      case 'tool_use': {
        trimLastToolResult(chatId);
        if (!state.quiet) {
          const line = formatToolUse(stripped);
          if (line) state.buffer += `\n${line}\n`;
        }
        break;
      }
      case 'tool_result':
        if (!state.quiet && stripped.length > 0) {
          const full = (stripped.length > 500 ? stripped.slice(0, 500) + '...' : stripped) + '\n';
          const short = (stripped.length > 100 ? stripped.slice(0, 100) + '...' : stripped) + '\n';
          state.lastToolFull = full;
          state.lastToolShort = short;
          state.buffer += full;
        }
        break;
      case 'error':
        state.buffer += `\n${stripped}\n`;
        break;
      case 'question':
        state.buffer += `\n${stripped}\n`;
        break;
      case 'user':
      case 'status':
      case 'result':
        break;
    }
  }

  let activeChatId: number | null = null;

  sessionManager.emitter.on('chunk', (chunk) => {
    if (activeChatId) appendChunk(activeChatId, chunk);
  });

  sessionManager.emitter.on('ended', () => {
    if (activeChatId) {
      stopStreaming(activeChatId);
      activeChatId = null;
    }
  });

  sessionManager.emitter.on('error', (err) => {
    if (activeChatId) {
      const state = getChatState(activeChatId);
      state.buffer += `\nError: ${err.message}`;
      stopStreaming(activeChatId);
      activeChatId = null;
    }
  });

  // --- Group helper ---

  function extractGroupPrompt(text: string): string | null {
    if (!botUsername) return null;
    const mentionRe = new RegExp(`@${botUsername}\\b`, 'gi');
    if (!mentionRe.test(text)) return null;
    return text.replace(mentionRe, '').trim();
  }

  // --- Commands ---

  bot.command('start', (ctx) =>
    ctx.reply(
      'CCWeb Telegram Bot\n\n' +
        'Send any message to prompt Claude Code.\n\n' +
        'Commands:\n' +
        '/stop - Stop current task\n' +
        '/new - New chat session\n' +
        '/chats - List chat sessions\n' +
        '/chat <number> - Switch to chat\n' +
        '/status - Current status\n' +
        '/project <path> - Switch project'
    )
  );

  bot.command('stop', async (ctx) => {
    if (activeChatId) stopStreaming(activeChatId);
    activeChatId = null;
    try {
      await sessionManager.interrupt();
    } catch {}
    await ctx.reply('Stopped.');
  });

  bot.command('new', async (ctx) => {
    const label = ctx.match?.trim() || undefined;
    const id = await sessionManager.newSession(label);
    const sessions = sessionManager.listSessions();
    const idx = sessions.findIndex((s) => s.id === id) + 1;
    await ctx.reply(`New chat #${idx}${label ? ` "${label}"` : ''} created.`);
  });

  bot.command('chats', async (ctx) => {
    const sessions = sessionManager.listSessions();
    const activeId = sessionManager.getActiveSessionId();
    if (sessions.length === 0) {
      await ctx.reply('No chats yet. Send a message to start one.');
      return;
    }
    const lines = sessions.map((s, i) => {
      const active = s.id === activeId ? ' *' : '';
      const preview = s.lastMessage ? ` — ${s.lastMessage}` : '';
      return `${i + 1}. ${s.label}${active}${preview}`;
    });
    await ctx.reply(lines.join('\n'));
  });

  bot.command('chat', async (ctx) => {
    const num = parseInt(ctx.match?.trim() ?? '', 10);
    const sessions = sessionManager.listSessions();
    if (!num || num < 1 || num > sessions.length) {
      await ctx.reply(`Usage: /chat <1-${sessions.length}>`);
      return;
    }
    const target = sessions[num - 1];
    sessionManager.switchSession(target.id);
    await ctx.reply(`Switched to ${target.label}.`);
  });

  bot.command('restart', async (ctx) => {
    activeChatId = ctx.chat.id;
    startStreaming(ctx.chat.id);
    sessionManager.restart().catch(() => {});
  });

  bot.command('status', async (ctx) => {
    const { session, projectPath } = sessionManager.getStatus();
    const sessions = sessionManager.listSessions();
    const statusIcon = session?.status === 'running' ? 'Running' : 'Idle';
    await ctx.reply(`${statusIcon}\nProject: ${projectPath}\nChats: ${sessions.length}`);
  });

  bot.command('quiet', async (ctx) => {
    const state = getChatState(ctx.chat.id);
    state.quiet = !state.quiet;
    await ctx.reply(state.quiet ? 'Quiet mode: ON (text only)' : 'Quiet mode: OFF (showing tools)');
  });

  bot.command('project', async (ctx) => {
    const path = ctx.match?.trim();
    if (!path) {
      await ctx.reply('Usage: /project <path>');
      return;
    }
    sessionManager.setProject(path);
    await ctx.reply(`Project set to: ${path}`);
  });

  bot.command('history', async (ctx) => {
    const sessions = sessionManager.getHistory(5);
    if (sessions.length === 0) {
      await ctx.reply('No sessions yet.');
      return;
    }
    const lines = sessions.map(
      (s, i) =>
        `${i + 1}. ${s.status === 'running' ? 'Running' : 'Idle'} ${s.startedAt.slice(0, 16)} | ${s.tokensUsed} tokens`
    );
    await ctx.reply(lines.join('\n'));
  });

  // --- Message handlers ---

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    let prompt = text;
    const reply = ctx.message.reply_to_message;
    const isReplyToBot = reply?.from?.id === me.id;

    if (isGroup(ctx.chat.type)) {
      // In groups: respond to @mentions OR replies to bot messages
      if (isReplyToBot) {
        // Reply to bot = trigger, no need for @mention
        prompt = text.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim();
        if (!prompt) return;
      } else {
        const extracted = extractGroupPrompt(text);
        if (extracted === null) return;
        prompt = extracted;
        if (!prompt) return;
      }
    }

    // Add quoted message context
    if (reply?.text) {
      const quoted = reply.text.length > 500 ? reply.text.slice(0, 500) + '...' : reply.text;
      prompt = `[Quoted message: ${quoted}]\n\n${prompt}`;
    } else if (reply?.caption) {
      const quoted = reply.caption.length > 500 ? reply.caption.slice(0, 500) + '...' : reply.caption;
      prompt = `[Quoted message: ${quoted}]\n\n${prompt}`;
    }

    activeChatId = ctx.chat.id;
    startStreaming(ctx.chat.id);

    // Don't await — results come via events. Awaiting blocks grammy's update queue
    // and prevents /stop from being processed while SDK is running.
    sessionManager.sendPrompt(prompt, 'telegram').catch((err) => {
      const state = getChatState(ctx.chat.id);
      state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
      stopStreaming(ctx.chat.id);
    });
  });

  bot.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || 'Analyze this image';
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const projectPath = sessionManager.getStatus().projectPath;
    const uploadsDir = join(projectPath, '.ccweb-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const fileName = `photo_${Date.now()}.jpg`;
    const filePath = join(uploadsDir, fileName);

    try {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);

      activeChatId = ctx.chat.id;
      startStreaming(ctx.chat.id);
      sessionManager.sendPrompt(
        `${caption}\n\n[Image saved to: ${filePath}]`,
        'telegram'
      ).catch((err) => {
        const state = getChatState(ctx.chat.id);
        state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
        stopStreaming(ctx.chat.id);
      });
    } catch (err) {
      await ctx.reply(
        `Failed to process image: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || `Process this file: ${doc.file_name}`;
    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const projectPath = sessionManager.getStatus().projectPath;
    const uploadsDir = join(projectPath, '.ccweb-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const fileName = doc.file_name ?? `file_${Date.now()}`;
    const filePath = join(uploadsDir, fileName);

    try {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);

      activeChatId = ctx.chat.id;
      startStreaming(ctx.chat.id);
      sessionManager.sendPrompt(
        `${caption}\n\n[File "${fileName}" saved to: ${filePath}]`,
        'telegram'
      ).catch((err) => {
        const state = getChatState(ctx.chat.id);
        state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
        stopStreaming(ctx.chat.id);
      });
    } catch (err) {
      await ctx.reply(
        `Failed to process file: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  bot.start();
  console.log('[telegram] Bot started');

  try {
    await bot.api.setMyCommands([
      { command: 'stop', description: 'Stop current task' },
      { command: 'new', description: 'New chat session' },
      { command: 'chats', description: 'List chat sessions' },
      { command: 'chat', description: 'Switch to chat by number' },
      { command: 'status', description: 'Current status' },
      { command: 'project', description: 'Switch project path' },
      { command: 'history', description: 'Recent session history' },
      { command: 'quiet', description: 'Toggle quiet mode (hide tools)' },
      { command: 'restart', description: 'Restart Claude session' },
    ]);
    console.log('[telegram] Bot commands registered');
  } catch (err) {
    console.error('[telegram] Failed to set bot commands:', err instanceof Error ? err.message : err);
  }

  return bot;
}

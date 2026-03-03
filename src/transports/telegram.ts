import { Bot } from 'grammy';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../core/session-manager.js';
import type { StreamChunk } from '../shared/types.js';

const FLUSH_INTERVAL_MS = 1500;
const TYPING_INTERVAL_MS = 4000;

/**
 * Convert Claude markdown output to Telegram HTML.
 * Handles: bold, italic, code, pre blocks, links, strikethrough.
 * Escapes HTML entities in non-formatted text.
 */
function markdownToTelegramHtml(text: string): string {
  // First, extract code blocks and inline code to protect them
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Replace fenced code blocks: ```lang\n...\n```
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

  // Replace inline code: `...`
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks and inline code
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

export async function startTelegramBot(
  sessionManager: SessionManager,
  token: string,
  allowedUsers: number[]
) {
  const bot = new Bot(token);

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (
      !userId ||
      (allowedUsers.length > 0 && !allowedUsers.includes(userId))
    ) {
      await ctx.reply('Unauthorized.');
      return;
    }
    await next();
  });

  // State per chat for streaming output
  const chatState = new Map<
    number,
    {
      buffer: string;
      fullText: string;
      flushTimer: ReturnType<typeof setInterval> | null;
      typingTimer: ReturnType<typeof setInterval> | null;
      draftId: number;
      draftSeq: number;
      abortController: AbortController | null;
    }
  >();

  function getChatState(chatId: number) {
    if (!chatState.has(chatId)) {
      chatState.set(chatId, {
        buffer: '',
        fullText: '',
        flushTimer: null,
        typingTimer: null,
        draftId: 0,
        draftSeq: 0,
        abortController: null,
      });
    }
    return chatState.get(chatId)!;
  }

  // Send typing indicator periodically
  function startTyping(chatId: number) {
    const state = getChatState(chatId);
    // Send immediately
    bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    // Then every 4s (TG clears after 5s)
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

  async function flushDraft(chatId: number) {
    const state = getChatState(chatId);
    if (!state.buffer && !state.fullText) return;

    const text = state.fullText + state.buffer;
    state.fullText = text;
    state.buffer = '';

    // Truncate for display if too long (TG limit 4096)
    let displayText = text;
    if (displayText.length > 4000) {
      displayText = '...' + displayText.slice(-3997);
    }
    if (!displayText) displayText = '...';

    try {
      await bot.api.sendMessageDraft(chatId, state.draftId, displayText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '';
      // Fallback: if sendMessageDraft fails (e.g. old API), ignore silently
      if (!errMsg.includes('not modified') && !errMsg.includes('DRAFT')) {
        console.error('[telegram] Draft error:', errMsg);
      }
    }
  }

  async function sendLongMessage(chatId: number, text: string, html?: string) {
    const TG_LIMIT = 4096;

    // Try HTML first, fall back to plain text
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

    // Split long text into chunks (use plain text for reliable splitting)
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

  async function finalizeDraft(chatId: number) {
    const state = getChatState(chatId);
    const text = state.fullText + state.buffer;
    state.buffer = '';
    state.fullText = '';

    if (!text.trim()) return;

    const html = markdownToTelegramHtml(text);
    await sendLongMessage(chatId, text, html);
  }

  function startStreaming(chatId: number) {
    const state = getChatState(chatId);
    state.buffer = '';
    state.fullText = '';
    state.draftSeq++;
    state.draftId = Date.now() % 1000000; // unique draft id per stream

    startTyping(chatId);

    if (state.flushTimer) clearInterval(state.flushTimer);
    state.flushTimer = setInterval(() => flushDraft(chatId), FLUSH_INTERVAL_MS);
  }

  function stopStreaming(chatId: number) {
    const state = getChatState(chatId);
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
    stopTyping(chatId);
    finalizeDraft(chatId);
  }

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
          return ''; // skip noise
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

  function appendChunk(chatId: number, chunk: StreamChunk) {
    const state = getChatState(chatId);
    const stripped = stripAnsi(chunk.content);

    switch (chunk.type) {
      case 'text':
        state.buffer += stripped;
        break;
      case 'tool_use': {
        const line = formatToolUse(stripped);
        if (line) state.buffer += `\n${line}\n`;
        break;
      }
      case 'tool_result':
        // Only show short results or errors, skip verbose output
        if (stripped.length > 0 && stripped.length <= 100) {
          state.buffer += `${stripped}\n`;
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

  // Commands
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
    // Stop streaming FIRST so no more chunks get appended
    if (activeChatId) stopStreaming(activeChatId);
    activeChatId = null; // Ignore any further chunks from SDK
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
    await sessionManager.restart();
  });

  bot.command('status', async (ctx) => {
    const { session, projectPath } = sessionManager.getStatus();
    const sessions = sessionManager.listSessions();
    const statusIcon = session?.status === 'running' ? 'Running' : 'Idle';
    await ctx.reply(`${statusIcon}\nProject: ${projectPath}\nChats: ${sessions.length}`);
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

  // Plain text = send prompt
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    activeChatId = ctx.chat.id;
    startStreaming(ctx.chat.id);

    try {
      await sessionManager.sendPrompt(text, 'telegram');
    } catch (err) {
      const state = getChatState(ctx.chat.id);
      state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
      stopStreaming(ctx.chat.id);
    }
  });

  // Photo handling
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
      await sessionManager.sendPrompt(
        `${caption}\n\n[Image saved to: ${filePath}]`,
        'telegram'
      );
    } catch (err) {
      await ctx.reply(
        `Failed to process image: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  // Document/file handling
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
      await sessionManager.sendPrompt(
        `${caption}\n\n[File "${fileName}" saved to: ${filePath}]`,
        'telegram'
      );
    } catch (err) {
      await ctx.reply(
        `Failed to process file: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  bot.start();
  console.log('[telegram] Bot started');

  // Set commands after bot.start() so the bot is already polling
  try {
    await bot.api.setMyCommands([
      { command: 'stop', description: 'Stop current task' },
      { command: 'new', description: 'New chat session' },
      { command: 'chats', description: 'List chat sessions' },
      { command: 'chat', description: 'Switch to chat by number' },
      { command: 'status', description: 'Current status' },
      { command: 'project', description: 'Switch project path' },
      { command: 'history', description: 'Recent session history' },
      { command: 'restart', description: 'Restart Claude session' },
    ]);
    console.log('[telegram] Bot commands registered');
  } catch (err) {
    console.error('[telegram] Failed to set bot commands:', err instanceof Error ? err.message : err);
  }

  return bot;
}

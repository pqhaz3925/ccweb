import { Bot } from 'grammy';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../core/session-manager.js';
import type { CCWebConfig, StreamChunk } from '../shared/types.js';

const EDIT_INTERVAL_MS = 1000;
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

  // Ensure ctx.reply preserves the forum topic (message_thread_id) of the triggering message.
  // grammy's ctx.reply does NOT auto-include it, so unthreaded replies hit the General topic (often closed).
  bot.use(async (ctx, next) => {
    const threadId = ctx.message?.message_thread_id;
    if (threadId) {
      const orig = ctx.reply.bind(ctx);
      ctx.reply = ((text: string, other?: Record<string, unknown>) =>
        orig(text, { message_thread_id: threadId, ...other })) as typeof ctx.reply;
    }
    await next();
  });

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

  // --- State per session (not per chat) ---

  interface StreamState {
    chatId: number;
    threadId: number | null; // forum topic thread id
    replyToMessageId: number | null; // reply to the user's triggering message
    buffer: string;
    sentText: string;
    messageId: number | null;
    flushTimer: ReturnType<typeof setInterval> | null;
    typingTimer: ReturnType<typeof setInterval> | null;
    lastToolFull: string | null;
    lastToolShort: string | null;
    quiet: boolean;
  }

  const streamState = new Map<string, StreamState>();

  /** Per-user quiet preference (persists across sessions) */
  const userQuiet = new Map<string, boolean>();

  function getStreamState(sessionId: string): StreamState | undefined {
    return streamState.get(sessionId);
  }

  function trimLastToolResult(sessionId: string) {
    const state = getStreamState(sessionId);
    if (!state?.lastToolFull || !state.lastToolShort) return;
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

  function startTyping(sessionId: string) {
    const state = getStreamState(sessionId);
    if (!state) return;
    const typingOpts = state.threadId ? { message_thread_id: state.threadId } : {};
    bot.api.sendChatAction(state.chatId, 'typing', typingOpts).catch(() => {});
    if (state.typingTimer) clearInterval(state.typingTimer);
    state.typingTimer = setInterval(() => {
      bot.api.sendChatAction(state.chatId, 'typing', typingOpts).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  function stopTyping(sessionId: string) {
    const state = getStreamState(sessionId);
    if (!state) return;
    if (state.typingTimer) {
      clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
  }

  // Maps (chatId, messageId) → sessionId so a reply to a bot message routes back to that chat.
  const messageOwner = new Map<string, string>();
  const ownerKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
  function recordOwner(chatId: number, messageId: number | null | undefined, sessionId: string) {
    if (!messageId) return;
    messageOwner.set(ownerKey(chatId, messageId), sessionId);
  }
  function findOwner(chatId: number, messageId: number): string | null {
    return messageOwner.get(ownerKey(chatId, messageId)) ?? null;
  }

  // Reply to a command, splitting on newlines so each message stays under Telegram's 4096 limit.
  async function replyChunked(ctx: { reply: (t: string) => Promise<unknown> }, text: string) {
    const LIMIT = 4000;
    if (text.length <= LIMIT) {
      await ctx.reply(text);
      return;
    }
    let buf = '';
    for (const line of text.split('\n')) {
      // A single line longer than the limit must be hard-split.
      if (line.length > LIMIT) {
        if (buf) { await ctx.reply(buf); buf = ''; }
        for (let i = 0; i < line.length; i += LIMIT) await ctx.reply(line.slice(i, i + LIMIT));
        continue;
      }
      if (buf.length + line.length + 1 > LIMIT) { await ctx.reply(buf); buf = ''; }
      buf += (buf ? '\n' : '') + line;
    }
    if (buf) await ctx.reply(buf);
  }

  function makeFooter(sessionId: string): string {
    const meta = sessionManager.getChatMeta(sessionId);
    if (!meta) return '';
    return `\n\n——— Chat #${meta.index} — ${meta.label}`;
  }

  // --- Send / Edit helpers ---

  async function editOrSend(
    chatId: number,
    text: string,
    messageId: number | null,
    sessionId: string,
    replyOpts?: { reply_to_message_id?: number; message_thread_id?: number },
    footer = ''
  ): Promise<number | null> {
    const html = markdownToTelegramHtml(text) + escapeHtml(footer);
    const plain = text + footer;

    if (messageId) {
      try {
        await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' });
        return messageId;
      } catch {
        try {
          await bot.api.editMessageText(chatId, messageId, plain);
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
        const result = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...replyOpts });
        recordOwner(chatId, result.message_id, sessionId);
        return result.message_id;
      } catch {
        try {
          const result = await bot.api.sendMessage(chatId, plain, { ...replyOpts });
          recordOwner(chatId, result.message_id, sessionId);
          return result.message_id;
        } catch (e: unknown) {
          console.error('[telegram] Send error:', e instanceof Error ? e.message : '');
          return null;
        }
      }
    }
  }

  async function sendLongMessage(chatId: number, text: string, sessionId: string, threadId?: number, footer = '') {
    const TG_LIMIT = 4096;
    const threadOpts = threadId ? { message_thread_id: threadId } : {};

    const withFooter = text + footer;
    if (withFooter.length <= TG_LIMIT) {
      const html = markdownToTelegramHtml(text) + escapeHtml(footer);
      try {
        const result = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...threadOpts });
        recordOwner(chatId, result.message_id, sessionId);
        return;
      } catch {
        try {
          const result = await bot.api.sendMessage(chatId, withFooter, { ...threadOpts });
          recordOwner(chatId, result.message_id, sessionId);
          return;
        } catch {}
      }
    }

    for (let i = 0; i < text.length; i += TG_LIMIT) {
      const isLast = i + TG_LIMIT >= text.length;
      const chunk = text.slice(i, i + TG_LIMIT) + (isLast ? footer : '');
      try {
        const result = await bot.api.sendMessage(chatId, chunk, { ...threadOpts });
        recordOwner(chatId, result.message_id, sessionId);
      } catch (e: unknown) {
        console.error('[telegram] Chunk send error:', e instanceof Error ? e.message : '');
      }
    }
  }

  // --- Streaming: send message, edit as text grows, new msg on limit ---

  async function flushEdit(sessionId: string, isFinal = false) {
    const state = getStreamState(sessionId);
    if (!state || !state.buffer.trim()) return;

    const newContent = state.buffer;
    state.buffer = '';

    const combined = state.sentText + newContent;

    // First message? Reply to triggering message. Always include thread if forum.
    const replyOpts: { reply_to_message_id?: number; message_thread_id?: number } = {};
    if (!state.messageId && state.replyToMessageId) replyOpts.reply_to_message_id = state.replyToMessageId;
    if (state.threadId) replyOpts.message_thread_id = state.threadId;
    const hasReplyOpts = Object.keys(replyOpts).length > 0 ? replyOpts : undefined;

    // Footer goes ONLY on the final message of a turn — otherwise rolled-over
    // intermediate messages freeze with a footer mid-sentence and look truncated.
    // But always reserve footer room in the budget so the final stamp fits under 4096.
    const fullFooter = makeFooter(sessionId);
    const footer = isFinal ? fullFooter : '';
    const budget = 4000 - fullFooter.length;

    if (combined.length <= budget) {
      state.messageId = await editOrSend(state.chatId, combined, state.messageId, sessionId, hasReplyOpts, footer);
      state.sentText = combined;
    } else {
      state.messageId = null;
      state.sentText = '';

      if (newContent.length <= budget) {
        state.messageId = await editOrSend(state.chatId, newContent, null, sessionId, hasReplyOpts, footer);
        state.sentText = newContent;
      } else {
        await sendLongMessage(state.chatId, newContent, sessionId, state.threadId ?? undefined, footer);
      }
    }
  }

  async function finalizeMessage(sessionId: string) {
    const state = getStreamState(sessionId);
    if (state?.buffer.trim()) {
      // There's pending text — flush it and stamp the footer on that final message.
      await flushEdit(sessionId, true);
    } else if (state?.messageId && state.sentText) {
      // Nothing new to send, but the last streamed message has no footer yet — add it.
      await editOrSend(state.chatId, state.sentText, state.messageId, sessionId, undefined, makeFooter(sessionId));
    }
    if (state) {
      state.messageId = null;
      state.sentText = '';
    }
  }

  function startStreaming(sessionId: string, chatId: number, replyToMessageId: number | null, userId: string, threadId?: number | null) {
    const quiet = userQuiet.get(userId) ?? false;
    streamState.set(sessionId, {
      chatId,
      threadId: threadId ?? null,
      replyToMessageId,
      buffer: '',
      sentText: '',
      messageId: null,
      flushTimer: null,
      typingTimer: null,
      lastToolFull: null,
      lastToolShort: null,
      quiet,
    });

    startTyping(sessionId);

    const state = getStreamState(sessionId)!;
    state.flushTimer = setInterval(() => {
      flushEdit(sessionId).catch(() => {});
    }, EDIT_INTERVAL_MS);
  }

  function stopStreaming(sessionId: string) {
    const state = getStreamState(sessionId);
    if (!state) return;
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }
    stopTyping(sessionId);
    finalizeMessage(sessionId).catch(() => {});
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

  function appendChunk(sessionId: string, chunk: StreamChunk) {
    const state = getStreamState(sessionId);
    if (!state) return;
    const stripped = stripAnsi(chunk.content);

    switch (chunk.type) {
      case 'text':
        trimLastToolResult(sessionId);
        state.buffer += stripped;
        break;
      case 'tool_use': {
        trimLastToolResult(sessionId);
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
      case 'thinking':
      case 'user':
      case 'status':
      case 'result':
        break;
    }
  }

  function getUserId(ctx: { from?: { id: number } }): string {
    return String(ctx.from?.id ?? 0);
  }

  sessionManager.emitter.on('chunk', (chunk, sessionId) => {
    if (streamState.has(sessionId)) appendChunk(sessionId, chunk);
  });

  sessionManager.emitter.on('ended', (session) => {
    if (streamState.has(session.id)) stopStreaming(session.id);
  });

  sessionManager.emitter.on('error', (err, sessionId) => {
    const state = getStreamState(sessionId);
    if (state) {
      state.buffer += `\nError: ${err.message}`;
      stopStreaming(sessionId);
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
    const uid = getUserId(ctx);
    const sid = sessionManager.getActiveSessionId(uid);
    if (sid) stopStreaming(sid);
    try {
      await sessionManager.interrupt(uid);
    } catch {}
    await ctx.reply('Stopped.');
  });

  bot.command('new', async (ctx) => {
    const uid = getUserId(ctx);
    const label = ctx.match?.trim() || undefined;
    const id = await sessionManager.newSession(label, uid);
    const meta = sessionManager.getChatMeta(id);
    await ctx.reply(`New chat #${meta?.index ?? '?'} ${label ? `"${label}" ` : ''}created.`);
  });

  bot.command('chats', async (ctx) => {
    const uid = getUserId(ctx);
    const sessions = sessionManager.listSessions();
    const activeId = sessionManager.getActiveSessionId(uid);
    if (sessions.length === 0) {
      await ctx.reply('No chats yet. Send a message to start one.');
      return;
    }
    const lines = sessions.map((s) => {
      const active = s.id === activeId ? ' *' : '';
      const preview = s.lastMessage ? ` — ${s.lastMessage}` : '';
      return `${s.chatNumber}. ${s.label}${active}${preview}`;
    });
    await replyChunked(ctx, lines.join('\n'));
  });

  bot.command('chat', async (ctx) => {
    const uid = getUserId(ctx);
    const num = parseInt(ctx.match?.trim() ?? '', 10);
    const sessions = sessionManager.listSessions();
    if (!num) {
      const numbers = sessions.map((s) => s.chatNumber).join(', ');
      await replyChunked(ctx, `Usage: /chat <number>\nAvailable: ${numbers}`);
      return;
    }
    const target = sessions.find((s) => s.chatNumber === num);
    if (!target) {
      await ctx.reply(`No chat #${num}.`);
      return;
    }
    sessionManager.switchSession(target.id, uid);
    await ctx.reply(`Switched to #${target.chatNumber} — ${target.label}.`);
  });

  bot.command('restart', async (ctx) => {
    const uid = getUserId(ctx);
    const sid = sessionManager.getActiveSessionId(uid);
    if (sid) startStreaming(sid, ctx.chat.id, ctx.message?.message_id ?? null, uid, ctx.message?.message_thread_id ?? null);
    sessionManager.restart(uid).catch(() => {});
  });

  bot.command('status', async (ctx) => {
    const uid = getUserId(ctx);
    const { session, projectPath } = sessionManager.getStatus(uid);
    const sessions = sessionManager.listSessions();
    const statusIcon = session?.status === 'running' ? 'Running' : 'Idle';
    await ctx.reply(`${statusIcon}\nProject: ${projectPath}\nChats: ${sessions.length}`);
  });

  bot.command('quiet', async (ctx) => {
    const uid = getUserId(ctx);
    const cur = userQuiet.get(uid) ?? false;
    userQuiet.set(uid, !cur);
    await ctx.reply(!cur ? 'Quiet mode: ON (text only)' : 'Quiet mode: OFF (showing tools)');
  });

  bot.command('compact', async (ctx) => {
    const uid = getUserId(ctx);
    const msg = await ctx.reply('Compacting context...');
    try {
      await sessionManager.compact(uid);
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, 'Context compacted.');
    } catch {
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, 'Compact failed or no active session.');
    }
  });

  bot.command('effort', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    if (!arg) {
      await ctx.reply(`Current effort: ${sessionManager.getEffort()}\n\nLevels: low, medium, high, xhigh, max`);
      return;
    }
    const valid = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!valid.includes(arg)) {
      await ctx.reply(`Invalid effort. Use: ${valid.join(', ')}`);
      return;
    }
    sessionManager.setEffort(arg);
    await ctx.reply(`Effort set to: ${arg}`);
  });

  bot.command('model', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase();
    if (!arg) {
      await ctx.reply(`Current model: ${sessionManager.getModel()}\n\nAliases: opus, sonnet, haiku, opus47, opus471m`);
      return;
    }
    const aliases: Record<string, string> = {
      'sonnet': 'claude-sonnet-4-6',
      'opus': 'claude-opus-4-8',
      'opus48': 'claude-opus-4-8',
      'opus481m': 'claude-opus-4-8[1m]',
      'opus47': 'claude-opus-4-7',
      'haiku': 'claude-haiku-4-5-20251001',
    };
    // Pass through whatever the user typed if it's not a known alias — proxy setups use
    // custom names like "cc/claude-opus-4-8[1m]" that we must not second-guess.
    const model = aliases[arg] ?? ctx.match!.trim();
    sessionManager.setModel(model);
    await ctx.reply(`Model set to: ${model}`);
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

  bot.command('title', async (ctx) => {
    const uid = getUserId(ctx);
    const arg = ctx.match?.trim();
    const sid = sessionManager.getActiveSessionId(uid);
    if (!sid) {
      await ctx.reply('No active chat. Send a message to start one.');
      return;
    }
    if (!arg) {
      const meta = sessionManager.getChatMeta(sid);
      await ctx.reply(meta ? `Current title: ${meta.label}\n\nUsage: /title <new title>` : 'No active chat.');
      return;
    }
    sessionManager.setLabel(sid, arg);
    const meta = sessionManager.getChatMeta(sid);
    await ctx.reply(`Title set: ${meta?.label}`);
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

    const uid = getUserId(ctx);
    const threadId = ctx.message.message_thread_id ?? null;

    // Reply-routing: if user replied to a bot message we recorded, route to that chat instead of active.
    const targetFromReply = isReplyToBot && reply ? findOwner(ctx.chat.id, reply.message_id) : null;
    const useTargetSession = targetFromReply && sessionManager.getChatMeta(targetFromReply) !== null;

    if (useTargetSession) {
      // Reuse existing streamState for steering so chunks keep flowing into the same TG message.
      const existing = streamState.get(targetFromReply);
      if (!existing || !existing.flushTimer) {
        startStreaming(targetFromReply, ctx.chat.id, ctx.message.message_id, uid, threadId);
      }
      sessionManager.sendPromptToSession(targetFromReply, prompt, 'telegram').then(() => {}, (err) => {
        const state = getStreamState(targetFromReply);
        if (state) state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
        stopStreaming(targetFromReply);
      });
      return;
    }

    // Default: route to user's active session
    const session = sessionManager.getActiveSessionId(uid);
    const sid = session ?? 'pending-' + uid;
    const existing = streamState.get(sid);
    // No state, or state was stopped (no flushTimer) → start a fresh stream.
    if (!existing || !existing.flushTimer) {
      startStreaming(sid, ctx.chat.id, ctx.message.message_id, uid, threadId);
    }

    sessionManager.sendPrompt(prompt, 'telegram', uid).then(() => {}, (err) => {
      const state = getStreamState(sid);
      if (state) state.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
      stopStreaming(sid);
    });

    const actualSid = sessionManager.getActiveSessionId(uid);
    if (actualSid && actualSid !== sid) {
      const state = streamState.get(sid);
      if (state) {
        streamState.set(actualSid, state);
        streamState.delete(sid);
      }
    }
  });

  bot.on('message:photo', async (ctx) => {
    const uid = getUserId(ctx);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || 'Analyze this image';
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const projectPath = sessionManager.getStatus(uid).projectPath;
    const uploadsDir = join(projectPath, '.ccweb-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const fileName = `photo_${Date.now()}.jpg`;
    const filePath = join(uploadsDir, fileName);

    try {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);

      const session = sessionManager.getActiveSessionId(uid);
      const sid = session ?? 'pending-' + uid;
      const existing = streamState.get(sid);
      if (!existing || !existing.flushTimer) {
        startStreaming(sid, ctx.chat.id, ctx.message.message_id, uid, ctx.message.message_thread_id ?? null);
      }
      sessionManager.sendPrompt(
        `${caption}\n\n[Image saved to: ${filePath}]`,
        'telegram',
        uid
      ).then(() => {}, (err) => {
        const st = getStreamState(sid);
        if (st) st.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
        stopStreaming(sid);
      });
      const actualSid = sessionManager.getActiveSessionId(uid);
      if (actualSid && actualSid !== sid) {
        const st = streamState.get(sid);
        if (st) { streamState.set(actualSid, st); streamState.delete(sid); }
      }
    } catch (err) {
      await ctx.reply(
        `Failed to process image: ${err instanceof Error ? err.message : 'unknown error'}`
      );
    }
  });

  bot.on('message:document', async (ctx) => {
    const uid = getUserId(ctx);
    const doc = ctx.message.document;
    const caption = ctx.message.caption || `Process this file: ${doc.file_name}`;
    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const projectPath = sessionManager.getStatus(uid).projectPath;
    const uploadsDir = join(projectPath, '.ccweb-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const fileName = doc.file_name ?? `file_${Date.now()}`;
    const filePath = join(uploadsDir, fileName);

    try {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);

      const session = sessionManager.getActiveSessionId(uid);
      const sid = session ?? 'pending-' + uid;
      const existing = streamState.get(sid);
      if (!existing || !existing.flushTimer) {
        startStreaming(sid, ctx.chat.id, ctx.message.message_id, uid, ctx.message.message_thread_id ?? null);
      }
      sessionManager.sendPrompt(
        `${caption}\n\n[File "${fileName}" saved to: ${filePath}]`,
        'telegram',
        uid
      ).then(() => {}, (err) => {
        const st = getStreamState(sid);
        if (st) st.buffer += `\n${err instanceof Error ? err.message : 'Unknown error'}`;
        stopStreaming(sid);
      });
      const actualSid = sessionManager.getActiveSessionId(uid);
      if (actualSid && actualSid !== sid) {
        const st = streamState.get(sid);
        if (st) { streamState.set(actualSid, st); streamState.delete(sid); }
      }
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
      { command: 'compact', description: 'Compact conversation context' },
      { command: 'model', description: 'Switch model (sonnet/opus/haiku)' },
      { command: 'effort', description: 'Set effort level (low/medium/high/xhigh/max)' },
      { command: 'project', description: 'Switch project path' },
      { command: 'title', description: 'Set the title shown in the chat footer' },
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

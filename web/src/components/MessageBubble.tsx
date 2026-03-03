import React, { useState } from 'react';
import type { ChatMessage } from '../hooks/useSession';
import { styles } from '../styles/theme';

/** Render text with basic markdown: **bold**, `code`, ```code blocks``` */
function renderMarkdown(text: string) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  const codeBlockRegex = /```(?:\w*\n)?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderInline(text.slice(lastIndex, match.index), key));
      key += 100;
    }
    parts.push(
      <pre key={`cb-${key++}`} style={styles.codeBlock}>{match[1].trim()}</pre>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(...renderInline(text.slice(lastIndex), key));
  }

  return parts;
}

function renderInline(text: string, keyStart: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = keyStart;

  const inlineRegex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={`b-${key++}`}>{match[2]}</strong>);
    } else if (match[4]) {
      parts.push(<code key={`c-${key++}`} style={styles.inlineCode}>{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function formatToolUse(content: string): { name: string; input: string } {
  try {
    const parsed = JSON.parse(content);
    const name = parsed.tool || 'Tool call';
    let input = '';
    if (parsed.input) {
      input = typeof parsed.input === 'string'
        ? parsed.input
        : JSON.stringify(parsed.input, null, 2);
      if (input.length > 500) input = input.slice(0, 500) + '...';
    }
    return { name, input };
  } catch {
    return { name: 'Tool call', input: content.slice(0, 200) };
  }
}

function ToolUseBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const { name, input } = formatToolUse(content);
  return (
    <div style={styles.toolMsg}>
      <div
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ fontSize: '11px', marginLeft: 8, opacity: 0.6 }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>
      {expanded && input && (
        <pre style={{ marginTop: 6, fontSize: '12px', opacity: 0.8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{input}</pre>
      )}
    </div>
  );
}

function ToolResultBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = content.length > 150;
  const preview = hasMore ? content.slice(0, 150) + '...' : content;
  return (
    <div style={{ ...styles.toolMsg, borderLeftColor: '#34d399', color: '#34d399' }}>
      <pre
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '12px', cursor: hasMore ? 'pointer' : 'default' }}
        onClick={() => hasMore && setExpanded(!expanded)}
      >
        {expanded ? content : preview}
      </pre>
    </div>
  );
}

const questionStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 12,
  background: '#1a1a2e',
  border: '1px solid #a78bfa44',
  color: '#e0e0e0',
  whiteSpace: 'pre-wrap',
  fontSize: '14px',
  lineHeight: 1.5,
  marginBottom: 4,
};

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  switch (msg.type) {
    case 'user':
      return <div style={styles.userMsg}>{msg.content}</div>;
    case 'assistant':
      return <div style={styles.assistantMsg}>{renderMarkdown(msg.content)}</div>;
    case 'tool_use':
      return <ToolUseBubble content={msg.content} />;
    case 'tool_result':
      return <ToolResultBubble content={msg.content} />;
    case 'question':
      return <div style={questionStyle}>{msg.content}</div>;
    case 'system':
    case 'status':
      return <div style={styles.systemMsg}>{msg.content}</div>;
    case 'error':
      return <div style={styles.errorMsg}>{msg.content}</div>;
    case 'result':
      return null;
    default:
      return <div style={styles.assistantMsg}>{msg.content}</div>;
  }
}

import { useState, useRef, useEffect } from 'react';
import { useSession } from './hooks/useSession';
import type { ChatMessage } from './hooks/useSession';

const styles = {
  app: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100dvh',
    backgroundColor: '#0a0a0a',
    color: '#e0e0e0',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #1a1a1a',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: '17px',
    fontWeight: 600,
    color: '#fff',
  },
  statusDot: (connected: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: connected ? '#34c759' : '#ff3b30',
    display: 'inline-block',
    marginRight: 8,
  }),
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    WebkitOverflowScrolling: 'touch' as const,
  },
  userMsg: {
    padding: '10px 14px',
    borderRadius: '16px',
    backgroundColor: '#1c3a5e',
    alignSelf: 'flex-end' as const,
    maxWidth: '85%',
    fontSize: '15px',
    lineHeight: '1.4',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    color: '#e0e0e0',
  },
  assistantMsg: {
    padding: '4px 0',
    fontSize: '15px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    color: '#e0e0e0',
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
  },
  toolMsg: {
    padding: '6px 10px',
    borderRadius: '8px',
    backgroundColor: '#1a1a2e',
    borderLeft: '3px solid #a78bfa',
    fontSize: '13px',
    color: '#a78bfa',
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
  },
  systemMsg: {
    padding: '2px 0',
    fontSize: '13px',
    color: '#64748b',
    fontStyle: 'italic' as const,
  },
  errorMsg: {
    padding: '6px 10px',
    borderRadius: '8px',
    backgroundColor: '#2d1515',
    borderLeft: '3px solid #ff6b6b',
    fontSize: '14px',
    color: '#ff6b6b',
  },
  inputArea: {
    display: 'flex',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid #1a1a1a',
    flexShrink: 0,
    paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
  },
  input: {
    flex: 1,
    padding: '10px 16px',
    borderRadius: '20px',
    border: '1px solid #333',
    backgroundColor: '#1a1a1a',
    color: '#e0e0e0',
    fontSize: '16px',
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'none' as const,
    minHeight: '40px',
    maxHeight: '120px',
  },
  button: (variant: 'send' | 'stop' | 'restart') => ({
    padding: '10px 16px',
    borderRadius: '20px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '15px',
    fontWeight: 600,
    flexShrink: 0,
    backgroundColor: variant === 'send' ? '#0a84ff' :
                     variant === 'stop' ? '#ff3b30' :
                     '#333',
    color: '#fff',
  }),
  controls: {
    display: 'flex',
    gap: '8px',
    padding: '0 16px 8px',
    flexShrink: 0,
  },
  sessionInfo: {
    fontSize: '12px',
    color: '#666',
    padding: '4px 16px',
  },
};

const globalStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { overflow: hidden; }
  input, textarea, button { -webkit-appearance: none; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
`;

function formatToolUse(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return `${parsed.tool}`;
  } catch {
    return 'Tool call';
  }
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  switch (msg.type) {
    case 'user':
      return <div style={styles.userMsg}>{msg.content}</div>;

    case 'assistant':
      return <div style={styles.assistantMsg}>{msg.content}</div>;

    case 'tool_use':
      return <div style={styles.toolMsg}>{formatToolUse(msg.content)}</div>;

    case 'system':
    case 'status':
      return <div style={styles.systemMsg}>{msg.content}</div>;

    case 'error':
      return <div style={styles.errorMsg}>{msg.content}</div>;

    case 'result':
      return <div style={{ ...styles.systemMsg, color: '#34c759' }}>{msg.content}</div>;

    default:
      return <div style={styles.assistantMsg}>{msg.content}</div>;
  }
}

export function App() {
  const { messages, connectionState, isRunning, sessionInfo, sendPrompt, interrupt, restart, clearMessages } = useSession();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;
    sendPrompt(trimmed);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  };

  const connected = connectionState === 'connected';

  return (
    <>
      <style>{globalStyles}</style>
      <div style={styles.app}>
        <div style={styles.header}>
          <div>
            <span style={styles.statusDot(connected)} />
            <span style={styles.headerTitle}>CCWeb</span>
          </div>
          {sessionInfo && (
            <span style={styles.sessionInfo}>
              {sessionInfo.tokensUsed > 0 ? `${(sessionInfo.tokensUsed / 1000).toFixed(1)}k tok` : ''}
              {sessionInfo.costUsd > 0 ? ` | $${sessionInfo.costUsd.toFixed(3)}` : ''}
            </span>
          )}
        </div>

        <div style={styles.messages}>
          {messages.length === 0 && (
            <div style={{ color: '#444', textAlign: 'center', marginTop: '40%', fontSize: '15px' }}>
              Send a message to start
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {isRunning && (
          <div style={styles.controls}>
            <button style={styles.button('stop')} onClick={interrupt}>Stop</button>
            <button style={styles.button('restart')} onClick={restart}>Restart</button>
          </div>
        )}

        {!isRunning && messages.length > 0 && (
          <div style={styles.controls}>
            <button style={styles.button('restart')} onClick={clearMessages}>Clear</button>
          </div>
        )}

        <div style={styles.inputArea}>
          <textarea
            ref={inputRef}
            style={styles.input}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Running...' : 'Message Claude Code...'}
            disabled={isRunning}
            rows={1}
          />
          <button
            style={styles.button('send')}
            onClick={handleSend}
            disabled={isRunning || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}

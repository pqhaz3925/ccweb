import React, { useState, useRef, useEffect } from 'react';
import { useSession } from './hooks/useSession';
import { MessageBubble } from './components/MessageBubble';
import { Drawer } from './components/Drawer';
import { SettingsPanel } from './components/SettingsPanel';
import { styles, globalStyles } from './styles/theme';

export function App() {
  const {
    messages, connectionState, isRunning, sessions, activeSessionId,
    sendPrompt, interrupt, restart, newSession, switchSession, rewind, clearMessages,
  } = useSession();
  const [input, setInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

      <div style={styles.overlay(drawerOpen)} onClick={() => setDrawerOpen(false)} />

      {drawerOpen && (
        <Drawer
          sessions={sessions}
          activeId={activeSessionId}
          onSwitch={switchSession}
          onNew={() => newSession()}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      <div style={styles.app}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <button style={styles.menuBtn} onClick={() => setDrawerOpen(true)}>
              {'\u2630'}
            </button>
            <span style={styles.statusDot(connected)} />
            <span style={styles.headerTitle}>CCWeb</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {sessions.length > 0 && (
              <span style={{ fontSize: '12px', color: '#555' }}>
                {sessions.find((s) => s.id === activeSessionId)?.label ?? ''}
              </span>
            )}
            <button style={styles.menuBtn} onClick={() => setSettingsOpen(true)}>
              {'\u2699'}
            </button>
          </div>
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
            <button style={styles.button('secondary')} onClick={restart}>Restart</button>
          </div>
        )}

        {!isRunning && messages.length > 0 && (
          <div style={styles.controls}>
            <button style={styles.button('secondary')} onClick={rewind}>Undo</button>
            <button style={styles.button('secondary')} onClick={() => newSession()}>New Chat</button>
            <button style={styles.button('secondary')} onClick={clearMessages}>Clear</button>
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

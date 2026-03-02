import { useState, useEffect, useRef, useCallback } from 'react';

type ServerMessage = {
  type: string;
  chunk?: { type: string; content: string; timestamp: number; metadata?: any };
  session?: any;
  error?: string;
  reason?: string;
  version?: string;
  project?: any;
  messages?: Array<{ type: string; content: string; timestamp: string }>;
};

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type ChatMessage = {
  id: number;
  type: 'user' | 'assistant' | 'tool_use' | 'system' | 'status' | 'error' | 'result';
  content: string;
  timestamp: number;
};

let msgIdCounter = 0;

// Chunk types that should be appended to the current assistant bubble
const STREAMABLE_TYPES = new Set(['text']);

export function useSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [isRunning, setIsRunning] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connected');
      ws.onclose = () => {
        setConnectionState('disconnected');
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);

        switch (msg.type) {
          case 'chunk':
            if (msg.chunk) {
              const chunk = msg.chunk;

              if (STREAMABLE_TYPES.has(chunk.type)) {
                // Append to existing assistant message or create new one
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.type === 'assistant') {
                    // Append to existing assistant bubble
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + chunk.content,
                      timestamp: chunk.timestamp,
                    };
                    return updated;
                  }
                  // New assistant bubble
                  return [...prev, {
                    id: ++msgIdCounter,
                    type: 'assistant',
                    content: chunk.content,
                    timestamp: chunk.timestamp,
                  }];
                });
              } else {
                // Non-text chunks (tool_use, system, status, error, result) get their own entry
                setMessages((prev) => [...prev, {
                  id: ++msgIdCounter,
                  type: chunk.type as ChatMessage['type'],
                  content: chunk.content,
                  timestamp: chunk.timestamp,
                }]);
              }
            }
            break;

          case 'session_started':
            setIsRunning(true);
            setSessionInfo(msg.session);
            break;

          case 'session_ended':
            setIsRunning(false);
            setSessionInfo(msg.session);
            break;

          case 'session_error':
            setMessages((prev) => [...prev, {
              id: ++msgIdCounter,
              type: 'error',
              content: msg.error || 'Unknown error',
              timestamp: Date.now(),
            }]);
            setIsRunning(false);
            break;

          case 'status':
            setSessionInfo(msg.session);
            if (msg.session) {
              setIsRunning(msg.session.status === 'running');
            }
            break;

          case 'history': {
            // Restore messages from server (on reconnect/reload)
            if (msg.messages && msg.messages.length > 0) {
              const restored: ChatMessage[] = [];
              for (const m of msg.messages) {
                if (STREAMABLE_TYPES.has(m.type)) {
                  const last = restored[restored.length - 1];
                  if (last && last.type === 'assistant') {
                    last.content += m.content;
                  } else {
                    restored.push({
                      id: ++msgIdCounter,
                      type: 'assistant',
                      content: m.content,
                      timestamp: Date.parse(m.timestamp) || Date.now(),
                    });
                  }
                } else {
                  restored.push({
                    id: ++msgIdCounter,
                    type: m.type as ChatMessage['type'],
                    content: m.content,
                    timestamp: Date.parse(m.timestamp) || Date.now(),
                  });
                }
              }
              setMessages(restored);
            }
            break;
          }

          case 'connected':
            break;
        }
      };
    }

    connect();
    return () => { wsRef.current?.close(); };
  }, []);

  const send = useCallback((msg: any) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendPrompt = useCallback((prompt: string) => {
    setMessages((prev) => [...prev, {
      id: ++msgIdCounter,
      type: 'user',
      content: prompt,
      timestamp: Date.now(),
    }]);
    send({ type: 'send_prompt', prompt });
  }, [send]);

  const interrupt = useCallback(() => send({ type: 'interrupt' }), [send]);
  const restart = useCallback(() => {
    setMessages([]);
    send({ type: 'restart' });
  }, [send]);
  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, connectionState, isRunning, sessionInfo, sendPrompt, interrupt, restart, clearMessages };
}

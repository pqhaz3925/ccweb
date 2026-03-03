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
  sessions?: SessionSummary[];
  activeId?: string | null;
};

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type ChatMessage = {
  id: number;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'status' | 'error' | 'result' | 'question';
  content: string;
  timestamp: number;
  source?: string;
};

export type SessionSummary = {
  id: string;
  label: string;
  status: string;
  startedAt: string;
  tokensUsed: number;
  lastMessage: string;
  active: boolean;
};

let msgIdCounter = 0;

const STREAMABLE_TYPES = new Set(['text']);

export function useSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [isRunning, setIsRunning] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<any>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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

              // User messages from server (from any transport)
              if (chunk.type === 'user') {
                // Only add if from another source (TG prompt showing in web)
                // If from web, we already added it locally via sendPrompt
                const source = chunk.metadata?.source;
                if (source !== 'web') {
                  setMessages((prev) => [...prev, {
                    id: ++msgIdCounter,
                    type: 'user',
                    content: chunk.content,
                    timestamp: chunk.timestamp,
                    source: source as string,
                  }]);
                }
                break;
              }

              if (STREAMABLE_TYPES.has(chunk.type)) {
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.type === 'assistant') {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      ...last,
                      content: last.content + chunk.content,
                      timestamp: chunk.timestamp,
                    };
                    return updated;
                  }
                  return [...prev, {
                    id: ++msgIdCounter,
                    type: 'assistant',
                    content: chunk.content,
                    timestamp: chunk.timestamp,
                  }];
                });
              } else {
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

          case 'sessions_list':
            if (msg.sessions) setSessions(msg.sessions);
            if (msg.activeId !== undefined) setActiveSessionId(msg.activeId);
            break;

          case 'history': {
            if (msg.messages) {
              if (msg.messages.length === 0) {
                setMessages([]);
                break;
              }
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
                } else if (m.type === 'user') {
                  restored.push({
                    id: ++msgIdCounter,
                    type: 'user',
                    content: m.content,
                    timestamp: Date.parse(m.timestamp) || Date.now(),
                  });
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
    // Add user message locally for instant feedback
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
  const newSession = useCallback((label?: string) => {
    send({ type: 'new_session', label });
  }, [send]);
  const switchSession = useCallback((sessionId: string) => {
    send({ type: 'switch_session', sessionId });
  }, [send]);
  const rewind = useCallback(() => {
    send({ type: 'rewind' });
  }, [send]);
  const clearMessages = useCallback(() => setMessages([]), []);

  return {
    messages, connectionState, isRunning, sessionInfo,
    sessions, activeSessionId,
    sendPrompt, interrupt, restart, newSession, switchSession, rewind, clearMessages,
  };
}

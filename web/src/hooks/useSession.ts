import { useState, useEffect, useRef, useCallback } from 'react';

type ServerMessage = {
  type: string;
  chunk?: { type: string; content: string; timestamp: number; metadata?: any };
  session?: any;
  error?: string;
  reason?: string;
  version?: string;
  project?: any;
};

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export function useSession() {
  const [messages, setMessages] = useState<Array<{ type: string; content: string; timestamp: number }>>([]);
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
              setMessages((prev) => [...prev, {
                type: msg.chunk!.type,
                content: msg.chunk!.content,
                timestamp: msg.chunk!.timestamp,
              }]);
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
    setMessages((prev) => [...prev, { type: 'user', content: prompt, timestamp: Date.now() }]);
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

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { useAuth } from './useAuth';

export type WSMessageType =
  | 'agent.list'
  | 'agent.get'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.enroll'
  | 'session.create'
  | 'session.join'
  | 'session.leave'
  | 'session.signal'
  | 'session.control'
  | 'desktop.frame'
  | 'desktop.config'
  | 'pty.data'
  | 'pty.resize'
  | 'pty.close'
  | 'file.list'
  | 'file.upload'
  | 'file.download'
  | 'file.delete'
  | 'file.mkdir'
  | 'process.list'
  | 'process.kill'
  | 'process.start'
  | 'script.run'
  | 'script.cancel'
  | 'telemetry.push'
  | 'audit.query'
  | 'error'
  | 'ack';

export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  request_id?: string;
  correlation_id?: string;
  error?: string;
}

export interface WSConnectionState {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastError?: string;
  reconnectAttempts: number;
}

interface WebSocketContextType {
  state: WSConnectionState;
  send: (type: WSMessageType, payload: unknown, requestId?: string) => Promise<WSMessage | null>;
  on: (type: WSMessageType, handler: (message: WSMessage) => void) => () => void;
  connect: () => void;
  disconnect: () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

const WS_URL = import.meta.env.VITE_WS_URL || 'wss://rmm.mezfashion.pro/ws';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000;

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [state, setState] = useState<WSConnectionState>({
    status: 'disconnected',
    reconnectAttempts: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<WSMessageType, Set<(msg: WSMessage) => void>>>(new Map());
  const pendingRequestsRef = useRef<Map<string, { resolve: (v: WSMessage) => void; reject: (e: Error) => void }>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const pingIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const requestIdCounter = useRef(0);

  const generateRequestId = useCallback(() => {
    return `req_${Date.now()}_${++requestIdCounter.current}`;
  }, []);

  const updateState = useCallback((partial: Partial<WSConnectionState>) => {
    setState(prev => ({ ...prev, ...partial }));
  }, []);

  const emit = useCallback((type: WSMessageType, message: WSMessage) => {
    const handlers = handlersRef.current.get(type);
    if (handlers) {
      handlers.forEach(h => h(message));
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: WSMessage = JSON.parse(event.data);

      if (message.request_id) {
        const pending = pendingRequestsRef.current.get(message.request_id);
        if (pending) {
          pendingRequestsRef.current.delete(message.request_id);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve(message);
          }
        }
      }

      emit(message.type, message);
    } catch (err) {
      console.error('Failed to parse WS message:', err);
    }
  }, [emit]);

  const handleOpen = useCallback(() => {
    updateState({ status: 'connected', reconnectAttempts: 0, lastError: undefined });

    pingIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping', payload: {} }));
      }
    }, PING_INTERVAL);
  }, [updateState]);

  const handleClose = useCallback(() => {
    updateState({ status: 'disconnected' });

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }

    pendingRequestsRef.current.forEach((_, id) => {
      pendingRequestsRef.current.get(id)?.reject(new Error('Connection closed'));
    });
    pendingRequestsRef.current.clear();

    if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_DELAY * Math.pow(1.5, state.reconnectAttempts);
      updateState({ reconnectAttempts: state.reconnectAttempts + 1 });
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    }
  }, [updateState, state.reconnectAttempts]);

  const handleError = useCallback(() => {
    updateState({ status: 'error', lastError: 'WebSocket error' });
  }, [updateState]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    updateState({ status: 'connecting' });

    const token = localStorage.getItem('access_token');
    const url = `${WS_URL}?token=${encodeURIComponent(token || '')}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = handleOpen;
    ws.onclose = handleClose;
    ws.onerror = handleError;
    ws.onmessage = handleMessage;
  }, [handleOpen, handleClose, handleError, handleMessage, updateState]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnect');
      wsRef.current = null;
    }
    updateState({ status: 'disconnected', reconnectAttempts: 0 });
  }, [updateState]);

  const send = useCallback(async (type: WSMessageType, payload: unknown, requestId?: string): Promise<WSMessage | null> => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const id = requestId || generateRequestId();
    const message: WSMessage = { type, payload, request_id: id };

    return new Promise((resolve, reject) => {
      pendingRequestsRef.current.set(id, { resolve, reject });

      wsRef.current!.send(JSON.stringify(message));

      setTimeout(() => {
        if (pendingRequestsRef.current.has(id)) {
          pendingRequestsRef.current.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }, [generateRequestId]);

  const on = useCallback((type: WSMessageType, handler: (message: WSMessage) => void) => {
    if (!handlersRef.current.has(type)) {
      handlersRef.current.set(type, new Set());
    }
    handlersRef.current.get(type)!.add(handler);

    return () => {
      handlersRef.current.get(type)?.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated && !authLoading) {
      connect();
    } else if (!isAuthenticated) {
      disconnect();
    }

    return () => disconnect();
  }, [isAuthenticated, authLoading, connect, disconnect]);

  return (
    <WebSocketContext.Provider value={{ state, send, on, connect, disconnect }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within WebSocketProvider');
  }
  return context;
}

export function useWSEvent(type: WSMessageType, handler: (message: WSMessage) => void) {
  const { on } = useWebSocket();

  useEffect(() => {
    return on(type, handler);
  }, [on, type, handler]);
}
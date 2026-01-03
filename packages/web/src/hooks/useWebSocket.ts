import { useEffect, useRef, useCallback, useState } from 'react';
import type { WSClientMessage, WSServerMessage } from '../types';

type MessageHandler = (message: WSServerMessage) => void;

interface UseWebSocketOptions {
  onMessage?: MessageHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 15000; // Send ping every 15 seconds
const HEARTBEAT_TIMEOUT = 5000; // Expect pong within 5 seconds

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { onMessage, onConnect, onDisconnect } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const heartbeatIntervalRef = useRef<number>();
  const heartbeatTimeoutRef = useRef<number>();
  const reconnectAttempts = useRef(0);
  const [isConnected, setIsConnected] = useState(false);
  
  // Use refs for callbacks to avoid re-creating connect function on every render
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  
  // Keep refs up to date
  useEffect(() => {
    onMessageRef.current = onMessage;
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
  });

  const clearTimers = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = undefined;
    }
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = undefined;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = undefined;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    // Send periodic pings to detect stale connections
    heartbeatIntervalRef.current = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Send a ping message
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
        
        // Set timeout for pong response
        heartbeatTimeoutRef.current = window.setTimeout(() => {
          console.warn('[Deadhand WebUI] Heartbeat timeout - closing stale connection');
          wsRef.current?.close();
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }, []);

  const connect = useCallback(() => {
    // Prevent multiple simultaneous connections
    if (wsRef.current && wsRef.current.readyState === WebSocket.CONNECTING) {
      return;
    }
    
    const token = localStorage.getItem('deadhand_token');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0; // Reset on successful connection
      setIsConnected(true);
      startHeartbeat();
      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSServerMessage;
        
        // Handle pong response (clears heartbeat timeout)
        if (message.type === 'pong') {
          if (heartbeatTimeoutRef.current) {
            clearTimeout(heartbeatTimeoutRef.current);
            heartbeatTimeoutRef.current = undefined;
          }
          return;
        }

        if (message.type === 'send_message_result') {
        }
        
        onMessageRef.current?.(message);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      clearTimers();
      onDisconnectRef.current?.();
      wsRef.current = null;

      // Exponential backoff for reconnection
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts.current),
        MAX_RECONNECT_DELAY
      );
      reconnectAttempts.current++;
      
      console.log(`[Deadhand WebUI] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // Don't close here - let onclose handle it
    };
  }, [clearTimers, startHeartbeat]);

  const disconnect = useCallback(() => {
    clearTimers();
    wsRef.current?.close();
    wsRef.current = null;
    setIsConnected(false);
  }, [clearTimers]);

  const send = useCallback((message: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Force reconnect (e.g., when user clicks retry)
  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttempts.current = 0;
    connect();
  }, [disconnect, connect]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, []); // Only run on mount/unmount

  return { isConnected, send, reconnect };
}


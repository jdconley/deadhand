import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { getSession } from '../api';
import type { EnabledModel, Instance, Session, SessionMode, TranscriptEvent, WSServerMessage } from '../types';
import { InstanceList } from './InstanceList';
import { SessionList } from './SessionList';
import { TranscriptView } from './TranscriptView';
import styles from './Dashboard.module.css';

type View = 'instances' | 'sessions' | 'transcript';

export function Dashboard() {
  const [instances, setInstances] = useState<Map<string, Instance>>(new Map());
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [transcriptEvents, setTranscriptEvents] = useState<TranscriptEvent[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [view, setView] = useState<View>('instances');
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  const [enabledModels, setEnabledModels] = useState<Map<string, EnabledModel[]>>(new Map());
  const [creatingChat, setCreatingChat] = useState(false);
  const [createChatError, setCreateChatError] = useState<string | null>(null);
  const [pendingNavigateSessionId, setPendingNavigateSessionId] = useState<string | null>(null);

  // Refs to avoid stale closures in callbacks
  const selectedInstanceIdRef = useRef(selectedInstanceId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const lastEventIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    selectedInstanceIdRef.current = selectedInstanceId;
  }, [selectedInstanceId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  // Add events with deduplication and proper ordering
  const addEvents = useCallback((newEvents: TranscriptEvent[], isHistorical = false) => {
    setTranscriptEvents((prev) => {
      // Dedupe: only add events we haven't seen
      const uniqueNewEvents = newEvents.filter(e => !seenEventIdsRef.current.has(e.eventId));
      if (uniqueNewEvents.length === 0) return prev;

      // Track new event IDs
      for (const e of uniqueNewEvents) {
        seenEventIdsRef.current.add(e.eventId);
      }

      // Merge events
      let merged: TranscriptEvent[];
      if (isHistorical) {
        // Historical events (from REST): merge and sort by timestamp
        merged = [...prev, ...uniqueNewEvents].sort((a, b) => 
          new Date(a.ts).getTime() - new Date(b.ts).getTime()
        );
      } else {
        // Live events: just append (they arrive in order)
        merged = [...prev, ...uniqueNewEvents];
      }

      // Update last event ID
      if (merged.length > 0) {
        lastEventIdRef.current = merged[merged.length - 1].eventId;
      }

      return merged;
    });
  }, []);

  const handleMessage = useCallback((message: WSServerMessage) => {
    switch (message.type) {
      case 'instance_update':
        setInstances((prev) => new Map(prev).set(message.instance.instanceId, message.instance));
        break;

      case 'instance_disconnect':
        setInstances((prev) => {
          const next = new Map(prev);
          next.delete(message.instanceId);
          return next;
        });
        // Clear selection if this instance was selected (use ref to avoid stale closure)
        if (selectedInstanceIdRef.current === message.instanceId) {
          setSelectedInstanceId(null);
          setView('instances');
        }
        break;

      case 'session_update':
        setSessions((prev) => new Map(prev).set(message.session.sessionId, message.session));
        break;

      case 'transcript_event':
        // Use ref to check current session (avoids stale closure)
        if (message.event.sessionId === selectedSessionIdRef.current) {
          addEvents([message.event]);
        }
        break;

      case 'enabled_models_result':
        if (message.success && message.models) {
          setEnabledModels((prev) => {
            const next = new Map(prev);
            next.set(message.instanceId, message.models ?? []);
            return next;
          });
        }
        break;

      case 'create_chat_result':
        setCreatingChat(false);
        if (message.success && message.composerId) {
          setCreateChatError(null);
          // Defer navigation to avoid referencing callbacks before they are initialized
          setPendingNavigateSessionId(message.composerId);
        } else {
          setCreateChatError(message.error || 'Failed to create chat');
        }
        break;

      case 'error':
        // Surface daemon-side errors so they don't fail silently.
        setCreateChatError(String(message.message || 'Server error'));
        break;
    }
  }, [addEvents]);

  // Function to subscribe and load session transcript
  // IMPORTANT: Subscribe FIRST to avoid race condition where events arrive
  // between REST response and subscription
  const loadAndSubscribeSession = useCallback(async (sessionId: string, send: (msg: any) => void) => {
    // 1. Subscribe for live updates FIRST
    // This ensures we capture any events that arrive during REST fetch
    send({ type: 'subscribe_session', sessionId });
    
    setIsLoadingTranscript(true);
    
    try {
      // 2. Then fetch historical transcript via REST
      const { events } = await getSession(sessionId);
      
      // 3. Merge historical events (will be sorted and deduped with any live events)
      if (selectedSessionIdRef.current === sessionId) {
        addEvents(events, true); // isHistorical=true for proper merge/sort
      }
    } catch (err) {
      console.error('Failed to load session transcript:', err);
    } finally {
      setIsLoadingTranscript(false);
    }
  }, [addEvents]);

  // Catch up on missed events (used after reconnect)
  const catchUpSession = useCallback(async (sessionId: string) => {
    if (!lastEventIdRef.current) return;

    try {
      const { events } = await getSession(sessionId, lastEventIdRef.current);
      if (selectedSessionIdRef.current === sessionId && events.length > 0) {
        addEvents(events, true); // isHistorical=true for proper ordering
      }
    } catch (err) {
      console.error('Failed to catch up session:', err);
    }
  }, [addEvents]);

  const { isConnected, send, reconnect } = useWebSocket({
    onMessage: handleMessage,
    onConnect: () => {
      console.log('[Deadhand WebUI] Connected, subscribing to instances...');
      
      // Clear any stale state from previous connection
      // This ensures we get fresh data from the daemon
      setInstances(new Map());
      setSessions(new Map());
      
      // Resubscribe to instances - will receive fresh list
      send({ type: 'subscribe_instances' });

      // Refresh enabled models for selected instance (if any)
      const instanceId = selectedInstanceIdRef.current;
      if (instanceId) {
        const requestId = `models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        send({ type: 'get_enabled_models', requestId, instanceId });
      }
      
      // If we had a session selected, reload it completely
      const sessionId = selectedSessionIdRef.current;
      if (sessionId) {
        console.log(`[Deadhand WebUI] Reconnected with session ${sessionId}, reloading...`);
        // Reset transcript state and reload
        setTranscriptEvents([]);
        seenEventIdsRef.current = new Set();
        lastEventIdRef.current = null;
        loadAndSubscribeSession(sessionId, send);
      }
    },
    onDisconnect: () => {
      console.log('[Deadhand WebUI] Disconnected, will reconnect automatically...');
      // Don't clear state here - we might reconnect quickly
      // State will be refreshed on reconnect
    },
  });

  const handleSelectInstance = useCallback((instanceId: string) => {
    setSelectedInstanceId(instanceId);
    setView('sessions');
    // Fetch enabled models for this instance
    const requestId = `models-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    send({ type: 'get_enabled_models', requestId, instanceId });
  }, [send]);

  const handleCreateChat = useCallback(
    (instanceId: string, prompt: string, mode: SessionMode, modelName?: string, maxMode?: boolean) => {
      if (!isConnected) {
        setCreateChatError('Not connected to daemon');
        return;
      }
      setCreatingChat(true);
      setCreateChatError(null);

      const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      send({
        type: 'create_chat',
        requestId,
        instanceId,
        prompt,
        unifiedMode: mode,
        modelName,
        maxMode,
      });

    },
    [isConnected, send]
  );

  const handleSelectSession = useCallback((sessionId: string) => {
    // Unsubscribe from previous session
    const prevSessionId = selectedSessionIdRef.current;
    if (prevSessionId) {
      send({ type: 'unsubscribe_session', sessionId: prevSessionId });
    }

    // Reset state for new session
    setSelectedSessionId(sessionId);
    setTranscriptEvents([]);
    seenEventIdsRef.current = new Set();
    lastEventIdRef.current = null;
    setView('transcript');

    // Load transcript and subscribe
    loadAndSubscribeSession(sessionId, send);
  }, [send, loadAndSubscribeSession]);

  // Navigate to a newly created session once we have a composerId from create_chat_result
  useEffect(() => {
    if (!pendingNavigateSessionId) return;
    handleSelectSession(pendingNavigateSessionId);
    setPendingNavigateSessionId(null);
  }, [pendingNavigateSessionId, handleSelectSession]);

  const handleBack = useCallback(() => {
    if (view === 'transcript') {
      const sessionId = selectedSessionIdRef.current;
      if (sessionId) {
        send({ type: 'unsubscribe_session', sessionId });
      }
      setSelectedSessionId(null);
      setTranscriptEvents([]);
      seenEventIdsRef.current = new Set();
      lastEventIdRef.current = null;
      setView('sessions');
    } else if (view === 'sessions') {
      setSelectedInstanceId(null);
      setView('instances');
    }
  }, [view, send]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('deadhand_token');
    window.location.reload();
  }, []);

  const selectedInstance = selectedInstanceId ? instances.get(selectedInstanceId) : null;
  const selectedSession = selectedSessionId ? sessions.get(selectedSessionId) : null;
  const selectedInstanceEnabledModels = selectedInstanceId ? enabledModels.get(selectedInstanceId) : undefined;

  const instanceSessions = useMemo(() => {
    if (!selectedInstanceId) return [];
    return Array.from(sessions.values()).filter((s) => s.instanceId === selectedInstanceId);
  }, [sessions, selectedInstanceId]);

  const instanceList = useMemo(() => Array.from(instances.values()), [instances]);

  const handleRefresh = useCallback(() => {
    console.log('[Deadhand WebUI] Manual refresh triggered');
    reconnect();
  }, [reconnect]);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          {view !== 'instances' && (
            <button className={styles.backButton} onClick={handleBack}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className={styles.headerTitle}>
            <h1>Deadhand</h1>
            <span 
              className={`${styles.status} ${isConnected ? styles.connected : styles.disconnected}`}
              onClick={!isConnected ? handleRefresh : undefined}
              style={!isConnected ? { cursor: 'pointer' } : undefined}
              title={!isConnected ? 'Click to reconnect' : undefined}
            >
              {isConnected ? 'Connected' : 'Reconnecting... (click to retry)'}
            </span>
          </div>
        </div>
        <div className={styles.headerRight}>
          <button 
            className={styles.refreshButton} 
            onClick={handleRefresh}
            title="Refresh connection"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6M23 20v-6h-6" />
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
            </svg>
          </button>
          <button className={styles.logoutButton} onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {view === 'instances' && (
          <InstanceList instances={instanceList} onSelect={handleSelectInstance} />
        )}

        {view === 'sessions' && selectedInstance && (
          <SessionList
            instance={selectedInstance}
            sessions={instanceSessions}
            onSelect={handleSelectSession}
            enabledModels={selectedInstanceEnabledModels}
            onCreateChat={(prompt, mode, modelName, maxMode) =>
              handleCreateChat(selectedInstance.instanceId, prompt, mode, modelName, maxMode)
            }
            creatingChat={creatingChat}
            createChatError={createChatError}
          />
        )}

        {view === 'transcript' && selectedSession && (
          <TranscriptView 
            session={selectedSession} 
            events={transcriptEvents}
            isLoading={isLoadingTranscript}
          />
        )}
      </main>
    </div>
  );
}

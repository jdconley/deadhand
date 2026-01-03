import { nanoid } from 'nanoid';
import type { Instance, Session, TranscriptEvent } from './types.js';
import type { PersistenceManager } from './persistence.js';

export interface InstanceRegistry {
  // Instance management
  registerInstance(instance: Omit<Instance, 'startedAt' | 'lastSeenAt'>): Instance;
  updateHeartbeat(instanceId: string): void;
  removeInstance(instanceId: string): void;
  getInstance(instanceId: string): Instance | undefined;
  getAllInstances(): Instance[];

  // Session management
  startSession(instanceId: string, session: Omit<Session, 'createdAt'>): Session;
  updateSession(sessionId: string, updates: Partial<Session>): Session | undefined;
  endSession(sessionId: string): void;
  getSession(sessionId: string): Session | undefined;
  getSessionsForInstance(instanceId: string): Session[];
  getAllSessions(): Session[];

  // Transcript events
  addTranscriptEvent(event: Omit<TranscriptEvent, 'eventId' | 'ts'> & { sourceId?: string }): TranscriptEvent | null;
  getTranscriptEvents(sessionId: string, afterEventId?: string): TranscriptEvent[];

  // Event subscription
  onInstanceChange(callback: (type: 'update' | 'disconnect', instance: Instance) => void): () => void;
  onSessionChange(callback: (type: 'start' | 'update' | 'end', session: Session) => void): () => void;
  onTranscriptEvent(callback: (event: TranscriptEvent) => void): () => void;
}

const MAX_EVENTS_PER_SESSION = 10000; // Bounded retention

export interface RegistryOptions {
  persistence?: PersistenceManager;
}

export function createInstanceRegistry(options: RegistryOptions = {}): InstanceRegistry {
  const { persistence } = options;
  
  const instances = new Map<string, Instance>();
  const sessions = new Map<string, Session>();
  const transcripts = new Map<string, TranscriptEvent[]>();
  
  // Track seen sourceIds for deduplication (in-memory, rebuilt from persistence)
  const seenSourceIds = new Map<string, Set<string>>();

  const instanceListeners: Set<(type: 'update' | 'disconnect', instance: Instance) => void> = new Set();
  const sessionListeners: Set<(type: 'start' | 'update' | 'end', session: Session) => void> = new Set();
  const transcriptListeners: Set<(event: TranscriptEvent) => void> = new Set();

  // Load persisted data on startup
  if (persistence) {
    console.log('[Registry] Loading persisted sessions...');
    const loadedSessions = persistence.loadSessions();
    for (const [id, session] of loadedSessions) {
      sessions.set(id, session);
    }
    console.log(`[Registry] Loaded ${loadedSessions.size} sessions from disk`);

    console.log('[Registry] Loading persisted transcripts...');
    const loadedTranscripts = persistence.loadAllTranscriptEvents();
    let totalEvents = 0;
    for (const [sessionId, events] of loadedTranscripts) {
      transcripts.set(sessionId, events);
      totalEvents += events.length;
      
      // Rebuild sourceId tracking
      const sourceIdSet = new Set<string>();
      for (const event of events) {
        if (event.sourceId) {
          sourceIdSet.add(event.sourceId);
        }
      }
      if (sourceIdSet.size > 0) {
        seenSourceIds.set(sessionId, sourceIdSet);
      }
    }
    console.log(`[Registry] Loaded ${totalEvents} transcript events from disk`);
  }

  function ensureSourceIdSet(sessionId: string): Set<string> {
    let set = seenSourceIds.get(sessionId);
    if (!set) {
      set = new Set();
      seenSourceIds.set(sessionId, set);
    }
    return set;
  }

  return {
    registerInstance(data) {
      const now = new Date().toISOString();
      const instance: Instance = {
        ...data,
        startedAt: now,
        lastSeenAt: now,
      };
      instances.set(data.instanceId, instance);
      instanceListeners.forEach((cb) => cb('update', instance));
      return instance;
    },

    updateHeartbeat(instanceId) {
      const instance = instances.get(instanceId);
      if (instance) {
        instance.lastSeenAt = new Date().toISOString();
        instanceListeners.forEach((cb) => cb('update', instance));
      }
    },

    removeInstance(instanceId) {
      const instance = instances.get(instanceId);
      if (instance) {
        instances.delete(instanceId);
        // Mark all sessions for this instance as disconnected (but don't delete - they're persisted)
        for (const [_sessionId, session] of sessions) {
          if (session.instanceId === instanceId && session.status === 'active') {
            session.status = 'idle';
            sessionListeners.forEach((cb) => cb('end', session));
            persistence?.persistSessionEnd(session.sessionId);
          }
        }
        instanceListeners.forEach((cb) => cb('disconnect', instance));
      }
    },

    getInstance(instanceId) {
      return instances.get(instanceId);
    },

    getAllInstances() {
      return Array.from(instances.values());
    },

    startSession(instanceId, data) {
      // Check if session already exists (e.g., reconnect scenario)
      const existing = sessions.get(data.sessionId);
      if (existing) {
        // Reactivate existing session
        existing.status = 'active';
        existing.instanceId = instanceId;
        sessionListeners.forEach((cb) => cb('update', existing));
        persistence?.persistSessionUpdate(data.sessionId, { status: 'active', instanceId });
        return existing;
      }

      const session: Session = {
        ...data,
        instanceId,
        createdAt: new Date().toISOString(),
      };
      sessions.set(data.sessionId, session);
      transcripts.set(data.sessionId, []);
      sessionListeners.forEach((cb) => cb('start', session));
      persistence?.persistSessionStart(session);
      return session;
    },

    updateSession(sessionId, updates) {
      const session = sessions.get(sessionId);
      if (session) {
        Object.assign(session, updates);
        sessionListeners.forEach((cb) => cb('update', session));
        persistence?.persistSessionUpdate(sessionId, updates);
        return session;
      }
      return undefined;
    },

    endSession(sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'idle';
        sessionListeners.forEach((cb) => cb('end', session));
        persistence?.persistSessionEnd(sessionId);
      }
    },

    getSession(sessionId) {
      return sessions.get(sessionId);
    },

    getSessionsForInstance(instanceId) {
      return Array.from(sessions.values()).filter((s) => s.instanceId === instanceId);
    },

    getAllSessions() {
      return Array.from(sessions.values());
    },

    addTranscriptEvent(data) {
      // Check for duplicate by sourceId
      if (data.sourceId) {
        const sourceIdSet = seenSourceIds.get(data.sessionId);
        if (sourceIdSet?.has(data.sourceId)) {
          // Duplicate event, skip
          return null;
        }
      }

      const event: TranscriptEvent = {
        ...data,
        eventId: nanoid(),
        ts: new Date().toISOString(),
      };

      let events = transcripts.get(data.sessionId);
      if (!events) {
        events = [];
        transcripts.set(data.sessionId, events);
      }

      events.push(event);

      // Track sourceId for deduplication
      if (event.sourceId) {
        ensureSourceIdSet(data.sessionId).add(event.sourceId);
      }

      // Bounded retention: remove oldest events if over limit
      while (events.length > MAX_EVENTS_PER_SESSION) {
        events.shift();
      }

      // Persist to disk
      persistence?.persistTranscriptEvent(event);

      transcriptListeners.forEach((cb) => cb(event));
      return event;
    },

    getTranscriptEvents(sessionId, afterEventId) {
      const events = transcripts.get(sessionId) || [];
      if (!afterEventId) return events;

      const idx = events.findIndex((e) => e.eventId === afterEventId);
      if (idx === -1) return events;
      return events.slice(idx + 1);
    },

    onInstanceChange(callback) {
      instanceListeners.add(callback);
      return () => instanceListeners.delete(callback);
    },

    onSessionChange(callback) {
      sessionListeners.add(callback);
      return () => sessionListeners.delete(callback);
    },

    onTranscriptEvent(callback) {
      transcriptListeners.add(callback);
      return () => transcriptListeners.delete(callback);
    },
  };
}

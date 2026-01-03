/**
 * Persistence layer for Deadhand daemon
 * 
 * Uses append-only JSONL files for durability:
 * - sessions.jsonl: session start/update/end events
 * - transcripts/<sessionId>.jsonl: transcript events per session
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, TranscriptEvent } from './types.js';

/** Session record types for JSONL storage */
type SessionRecord =
  | { action: 'start'; session: Session; ts: string }
  | { action: 'update'; sessionId: string; updates: Partial<Session>; ts: string }
  | { action: 'end'; sessionId: string; ts: string };

export interface PersistenceManager {
  // Session persistence
  persistSessionStart(session: Session): void;
  persistSessionUpdate(sessionId: string, updates: Partial<Session>): void;
  persistSessionEnd(sessionId: string): void;
  
  // Transcript persistence
  persistTranscriptEvent(event: TranscriptEvent): void;
  
  // Load on startup
  loadSessions(): Map<string, Session>;
  loadTranscriptEvents(sessionId: string): TranscriptEvent[];
  loadAllTranscriptEvents(): Map<string, TranscriptEvent[]>;
  
  // Deduplication helpers
  hasSourceId(sessionId: string, sourceId: string): boolean;
}

export function createPersistenceManager(dataDir: string): PersistenceManager {
  const sessionsFile = join(dataDir, 'sessions.jsonl');
  const transcriptsDir = join(dataDir, 'transcripts');
  
  // Track seen sourceIds per session for fast deduplication
  const seenSourceIds = new Map<string, Set<string>>();

  // Ensure directories exist
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  if (!existsSync(transcriptsDir)) {
    mkdirSync(transcriptsDir, { recursive: true });
  }

  function appendLine(filePath: string, data: unknown): void {
    const line = JSON.stringify(data) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  }

  function readLines<T>(filePath: string): T[] {
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());
    const results: T[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch (err) {
        console.error(`Failed to parse JSONL line: ${line}`, err);
      }
    }
    return results;
  }

  function getTranscriptFile(sessionId: string): string {
    // Sanitize sessionId for filesystem safety
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(transcriptsDir, `${safeId}.jsonl`);
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
    persistSessionStart(session) {
      const record: SessionRecord = {
        action: 'start',
        session,
        ts: new Date().toISOString(),
      };
      appendLine(sessionsFile, record);
    },

    persistSessionUpdate(sessionId, updates) {
      const record: SessionRecord = {
        action: 'update',
        sessionId,
        updates,
        ts: new Date().toISOString(),
      };
      appendLine(sessionsFile, record);
    },

    persistSessionEnd(sessionId) {
      const record: SessionRecord = {
        action: 'end',
        sessionId,
        ts: new Date().toISOString(),
      };
      appendLine(sessionsFile, record);
    },

    persistTranscriptEvent(event) {
      appendLine(getTranscriptFile(event.sessionId), event);
      
      // Track sourceId for deduplication
      if (event.sourceId) {
        ensureSourceIdSet(event.sessionId).add(event.sourceId);
      }
    },

    loadSessions(): Map<string, Session> {
      const sessions = new Map<string, Session>();
      const records = readLines<SessionRecord>(sessionsFile);

      for (const record of records) {
        switch (record.action) {
          case 'start':
            sessions.set(record.session.sessionId, { ...record.session });
            break;
          case 'update': {
            const session = sessions.get(record.sessionId);
            if (session) {
              Object.assign(session, record.updates);
            }
            break;
          }
          case 'end': {
            const session = sessions.get(record.sessionId);
            if (session) {
              session.status = 'idle';
            }
            break;
          }
        }
      }

      return sessions;
    },

    loadTranscriptEvents(sessionId): TranscriptEvent[] {
      const events = readLines<TranscriptEvent>(getTranscriptFile(sessionId));
      
      // Rebuild sourceId tracking
      const sourceIdSet = ensureSourceIdSet(sessionId);
      for (const event of events) {
        if (event.sourceId) {
          sourceIdSet.add(event.sourceId);
        }
      }
      
      return events;
    },

    loadAllTranscriptEvents(): Map<string, TranscriptEvent[]> {
      const result = new Map<string, TranscriptEvent[]>();
      
      if (!existsSync(transcriptsDir)) {
        return result;
      }

      const files = readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const events = this.loadTranscriptEvents(sessionId);
        if (events.length > 0) {
          result.set(sessionId, events);
        }
      }

      return result;
    },

    hasSourceId(sessionId, sourceId): boolean {
      const set = seenSourceIds.get(sessionId);
      return set?.has(sourceId) ?? false;
    },
  };
}


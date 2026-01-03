import { useEffect, useMemo, useState } from 'react';
import type { EnabledModel, Instance, Session, SessionMode } from '../types';
import { getModeLabel } from '../types';
import styles from './SessionList.module.css';

interface SessionListProps {
  instance: Instance;
  sessions: Session[];
  onSelect: (sessionId: string) => void;
  enabledModels?: EnabledModel[];
  onCreateChat?: (prompt: string, mode: SessionMode, modelName?: string, maxMode?: boolean) => void;
  creatingChat?: boolean;
  createChatError?: string | null;
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getStatusColor(status: Session['status']): string {
  switch (status) {
    case 'active':
      return 'var(--color-success)';
    case 'error':
      return 'var(--color-error)';
    default:
      return 'var(--color-text-dim)';
  }
}

function getModeColor(mode?: SessionMode): string {
  switch (mode) {
    case 'agent':
      return 'var(--color-success)';
    case 'chat':
      return 'var(--color-primary)';
    case 'plan':
      return 'var(--color-warning)';
    case 'debug':
      return 'var(--color-error)';
    case 'background':
      return 'var(--color-text-dim)';
    default:
      return 'var(--color-text-muted)';
  }
}

function formatStats(session: Session): string | null {
  const parts: string[] = [];
  
  if (session.filesChangedCount && session.filesChangedCount > 0) {
    parts.push(`${session.filesChangedCount} file${session.filesChangedCount > 1 ? 's' : ''}`);
  }
  
  if (session.totalLinesAdded && session.totalLinesAdded > 0) {
    parts.push(`+${session.totalLinesAdded}`);
  }
  
  if (session.totalLinesRemoved && session.totalLinesRemoved > 0) {
    parts.push(`-${session.totalLinesRemoved}`);
  }
  
  if (session.contextUsagePercent && session.contextUsagePercent > 0) {
    parts.push(`${Math.round(session.contextUsagePercent)}% ctx`);
  }
  
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function SessionList({
  instance,
  sessions,
  onSelect,
  enabledModels,
  onCreateChat,
  creatingChat,
  createChatError,
}: SessionListProps) {
  const [newPrompt, setNewPrompt] = useState('');
  const [mode, setMode] = useState<SessionMode>('chat'); // "Ask" in Cursor UI
  const [modelName, setModelName] = useState<string>(''); // empty = no override (use default)
  const [maxMode, setMaxMode] = useState(false);

  const selectedModel = useMemo(
    () => (enabledModels ? enabledModels.find((m) => m.name === modelName) : undefined),
    [enabledModels, modelName]
  );

  // If model doesn't support max mode, force it off.
  useEffect(() => {
    if (selectedModel?.supportsMaxMode === false && maxMode) {
      setMaxMode(false);
    }
  }, [selectedModel?.supportsMaxMode, maxMode]);

  const canUseMaxMode = selectedModel ? selectedModel.supportsMaxMode !== false : false;

  const handleCreateChatClick = () => {
    if (!onCreateChat) return;
    const prompt = newPrompt.trim();
    if (!prompt) return;
    onCreateChat(prompt, mode, modelName || undefined, maxMode);
    setNewPrompt('');
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>{instance.workspaceName}</h2>
        <p className={styles.subtitle}>{instance.workspacePath}</p>

        {onCreateChat && (
          <div className={styles.createChat}>
            <div className={styles.createChatTitle}>New chat</div>
            <div className={styles.createChatRow}>
              <textarea
                className={styles.createChatPrompt}
                placeholder="Enter a prompt to start a new chat…"
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                rows={2}
              />
            </div>
            <div className={styles.createChatRow}>
              <label className={styles.createChatLabel}>
                Mode
                <select
                  className={styles.createChatSelect}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as SessionMode)}
                >
                  <option value="chat">Ask</option>
                  <option value="agent">Agent</option>
                  <option value="debug">Debug</option>
                  <option value="plan">Plan</option>
                  <option value="background">Background</option>
                </select>
              </label>

              <label className={styles.createChatLabel}>
                Model
                <select
                  className={styles.createChatSelect}
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                >
                  <option value="">Auto (no override)</option>
                  {(enabledModels ?? []).map((m) => {
                    const label = m.clientDisplayName ? `${m.clientDisplayName} (${m.name})` : m.name;
                    return (
                      <option key={m.name} value={m.name}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </label>

              <label className={styles.createChatToggle}>
                <input
                  type="checkbox"
                  checked={maxMode}
                  disabled={!canUseMaxMode || !modelName || creatingChat}
                  onChange={(e) => setMaxMode(e.target.checked)}
                />
                MAX mode
              </label>

              <button
                className={styles.createChatButton}
                onClick={handleCreateChatClick}
                disabled={!newPrompt.trim() || creatingChat}
                title={!newPrompt.trim() ? 'Enter a prompt first' : undefined}
              >
                {creatingChat ? 'Starting…' : 'Start'}
              </button>
            </div>
            {createChatError && <div className={styles.createChatError}>{createChatError}</div>}
          </div>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3>No active sessions</h3>
          <p>Start an agent conversation in Cursor to see it here</p>
        </div>
      ) : (
        <div className={styles.list}>
          {sessions.map((session) => {
            const stats = formatStats(session);
            return (
              <button
                key={session.sessionId}
                className={styles.item}
                onClick={() => onSelect(session.sessionId)}
              >
                <div
                  className={styles.itemStatus}
                  style={{ backgroundColor: getStatusColor(session.status) }}
                />
                <div className={styles.itemContent}>
                  <div className={styles.itemHeader}>
                    <span className={styles.itemTitle}>{session.title || 'Untitled session'}</span>
                    <span className={styles.itemTime}>{formatTime(session.createdAt)}</span>
                  </div>
                  <div className={styles.itemMeta}>
                    <span 
                      className={styles.itemMode}
                      style={{ 
                        color: getModeColor(session.mode),
                        borderColor: getModeColor(session.mode)
                      }}
                    >
                      {getModeLabel(session.mode)}
                    </span>
                    {stats && (
                      <span className={styles.itemStats}>{stats}</span>
                    )}
                    {session.subtitle && (
                      <span className={styles.itemSubtitle} title={session.subtitle}>
                        {session.subtitle.length > 40 ? session.subtitle.slice(0, 40) + '...' : session.subtitle}
                      </span>
                    )}
                  </div>
                </div>
                <div className={styles.itemArrow}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


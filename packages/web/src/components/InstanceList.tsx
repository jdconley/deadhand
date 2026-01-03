import type { Instance } from '../types';
import styles from './InstanceList.module.css';

interface InstanceListProps {
  instances: Instance[];
  onSelect: (instanceId: string) => void;
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function InstanceList({ instances, onSelect }: InstanceListProps) {
  if (instances.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
        </div>
        <h2>No Cursor instances connected</h2>
        <p>Install the Deadhand extension in Cursor to get started</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Cursor Instances</h2>
      <p className={styles.subtitle}>{instances.length} connected</p>

      <div className={styles.list}>
        {instances.map((instance) => (
          <button
            key={instance.instanceId}
            className={styles.item}
            onClick={() => onSelect(instance.instanceId)}
          >
            <div className={styles.itemIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div className={styles.itemContent}>
              <div className={styles.itemHeader}>
                <span className={styles.itemName}>{instance.workspaceName}</span>
                <span className={styles.itemTime}>{formatTimeAgo(instance.lastSeenAt)}</span>
              </div>
              <div className={styles.itemMeta}>
                <span className={styles.itemApp}>{instance.app} {instance.appVersion}</span>
                <span className={styles.itemPid}>PID {instance.pid}</span>
              </div>
              <div className={styles.itemPath}>{instance.workspacePath}</div>
            </div>
            <div className={styles.itemArrow}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}


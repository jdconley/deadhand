import { useState } from 'react';
import { validateToken, getInfo } from '../api';
import styles from './LoginPage.module.css';

interface LoginPageProps {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Fetch server info on mount
  useState(() => {
    getInfo().then((info) => {
      setFingerprint(info.fingerprint);
    }).catch(() => {});
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const valid = await validateToken(token.trim());
      if (valid) {
        localStorage.setItem('deadhand_token', token.trim());
        onLogin();
      } else {
        setError('Authorization denied');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.cardInner}>
          <div className={styles.logo}>
            {/* Nuclear/Missile Warning Symbol */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              {/* Outer warning triangle */}
              <path d="M12 2L2 20h20L12 2z" fill="none" />
              {/* Inner radiation symbol - simplified */}
              <circle cx="12" cy="14" r="2" fill="currentColor" stroke="none" />
              <path d="M12 8v2" strokeWidth="2" strokeLinecap="round" />
              <path d="M9 16l-1.5 1.5" strokeWidth="2" strokeLinecap="round" />
              <path d="M15 16l1.5 1.5" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p className={styles.restricted}>⚠ Access Restricted ⚠</p>
          <h1 className={styles.title}>Deadhand</h1>
          <p className={styles.subtitle}>Remote Agent Monitoring System</p>

          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.label}>
              Authorization Token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter access code"
                className={styles.input}
                autoComplete="off"
                autoFocus
              />
            </label>

            {error && <p className={styles.error}>▲ {error}</p>}

            <button type="submit" className={styles.button} disabled={loading || !token.trim()}>
              {loading ? 'Authenticating...' : 'Authenticate'}
            </button>
          </form>

          {fingerprint && (
            <div className={styles.fingerprint}>
              <p className={styles.fingerprintLabel}>TLS Certificate Fingerprint</p>
              <code className={styles.fingerprintValue}>{fingerprint}</code>
              <p className={styles.fingerprintHint}>
                Verify this matches the fingerprint shown in your terminal
              </p>
            </div>
          )}

          <p className={styles.hint}>
            Authorization token available in daemon terminal output
          </p>
        </div>
      </div>
    </div>
  );
}

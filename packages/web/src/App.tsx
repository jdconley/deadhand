import { useState, useEffect } from 'react';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';

/**
 * Parse token from URL fragment (#token=...)
 * Returns the token if found, null otherwise
 */
function parseTokenFromFragment(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;

  // Parse fragment as URL params (remove leading #)
  const params = new URLSearchParams(hash.slice(1));
  return params.get('token');
}

/**
 * Clear the URL fragment without triggering a page reload
 */
function clearFragment(): void {
  // Use replaceState to remove hash without page reload or history entry
  const url = window.location.pathname + window.location.search;
  window.history.replaceState(null, '', url);
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    // Check for token in URL fragment first (auto-login from QR code)
    const fragmentToken = parseTokenFromFragment();
    if (fragmentToken) {
      // Store the token and clear the fragment from URL
      localStorage.setItem('deadhand_token', fragmentToken);
      clearFragment();
      setIsAuthenticated(true);
      return;
    }

    // Fall back to checking stored token
    const storedToken = localStorage.getItem('deadhand_token');
    setIsAuthenticated(!!storedToken);
  }, []);

  // Loading state
  if (isAuthenticated === null) {
    return null;
  }

  if (!isAuthenticated) {
    return <LoginPage onLogin={() => setIsAuthenticated(true)} />;
  }

  return <Dashboard />;
}


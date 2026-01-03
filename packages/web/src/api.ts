import type { Instance, Session, TranscriptEvent } from './types';

function getToken(): string | null {
  return localStorage.getItem('deadhand_token');
}

async function fetchWithAuth(url: string): Promise<Response> {
  const token = getToken();
  if (!token) {
    throw new Error('No token');
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem('deadhand_token');
      window.location.reload();
    }
    throw new Error(`HTTP ${response.status}`);
  }

  return response;
}

export async function getInstances(): Promise<Instance[]> {
  const response = await fetchWithAuth('/api/v1/instances');
  return response.json();
}

export async function getInstance(instanceId: string): Promise<Instance> {
  const response = await fetchWithAuth(`/api/v1/instances/${instanceId}`);
  return response.json();
}

export async function getSessions(instanceId: string): Promise<Session[]> {
  const response = await fetchWithAuth(`/api/v1/instances/${instanceId}/sessions`);
  return response.json();
}

export async function getSession(sessionId: string, afterEventId?: string): Promise<{ session: Session; events: TranscriptEvent[] }> {
  const url = afterEventId 
    ? `/api/v1/sessions/${sessionId}?after=${encodeURIComponent(afterEventId)}`
    : `/api/v1/sessions/${sessionId}`;
  const response = await fetchWithAuth(url);
  return response.json();
}

export async function getInfo(): Promise<{ name: string; version: string; fingerprint: string | null }> {
  const response = await fetch('/api/v1/info');
  return response.json();
}

export async function validateToken(token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/instances', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}


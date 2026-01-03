import * as https from 'https';
import * as http from 'http';
import { getConfig } from '../config';

export interface DaemonInfo {
  reachable: boolean;
  scheme: 'http' | 'https' | null;
  fingerprint: string | null;
  version: string | null;
}

/**
 * Probe the daemon to determine if it's running and what mode it's in
 */
export async function probeDaemon(): Promise<DaemonInfo> {
  const config = getConfig();
  const port = config.daemonPort;

  // Try HTTPS first (LAN mode)
  const httpsResult = await tryProbe('https', port);
  if (httpsResult.reachable) {
    return httpsResult;
  }

  // Fall back to HTTP (localhost-only mode)
  const httpResult = await tryProbe('http', port);
  return httpResult;
}

async function tryProbe(scheme: 'http' | 'https', port: number): Promise<DaemonInfo> {
  const url = `${scheme}://127.0.0.1:${port}/api/v1/info`;

  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      method: 'GET',
      timeout: 3000,
      rejectUnauthorized: false, // Accept self-signed certs
    };

    const client = scheme === 'https' ? https : http;

    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            reachable: true,
            scheme,
            fingerprint: json.fingerprint || null,
            version: json.version || null,
          });
        } catch {
          resolve({
            reachable: true,
            scheme,
            fingerprint: null,
            version: null,
          });
        }
      });
    });

    req.on('error', () => {
      resolve({
        reachable: false,
        scheme: null,
        fingerprint: null,
        version: null,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        reachable: false,
        scheme: null,
        fingerprint: null,
        version: null,
      });
    });

    req.end();
  });
}

/**
 * Get all LAN IP addresses for this machine
 */
export function getLanAddresses(): string[] {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.internal || iface.family !== 'IPv4') {
        continue;
      }
      addresses.push(iface.address);
    }
  }

  return addresses;
}

/**
 * Build a web UI URL with optional token in fragment
 */
export function buildWebUrl(
  scheme: 'http' | 'https',
  host: string,
  port: number,
  token?: string
): string {
  const base = `${scheme}://${host}:${port}`;
  if (token) {
    return `${base}/#token=${encodeURIComponent(token)}`;
  }
  return base;
}


import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import selfsigned from 'selfsigned';

export interface TLSCredentials {
  key: string;
  cert: string;
  fingerprint: string;
}

const CERT_FILENAME = 'server.crt';
const KEY_FILENAME = 'server.key';

/**
 * Generate a SHA-256 fingerprint from a PEM certificate
 */
function computeFingerprint(certPem: string): string {
  // Extract the base64 content between BEGIN and END
  const matches = certPem.match(/-----BEGIN CERTIFICATE-----\s*([\s\S]+?)\s*-----END CERTIFICATE-----/);
  if (!matches || !matches[1]) {
    throw new Error('Invalid PEM certificate');
  }
  const der = Buffer.from(matches[1].replace(/\s/g, ''), 'base64');
  const hash = createHash('sha256').update(der).digest('hex').toUpperCase();
  // Format as colon-separated pairs
  return hash.match(/.{2}/g)!.join(':');
}

/**
 * Load existing TLS credentials or generate new self-signed ones
 */
export function loadOrGenerateTLS(dataDir: string): TLSCredentials {
  const certPath = join(dataDir, CERT_FILENAME);
  const keyPath = join(dataDir, KEY_FILENAME);

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Try to load existing credentials
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf-8');
    const key = readFileSync(keyPath, 'utf-8');
    const fingerprint = computeFingerprint(cert);
    return { cert, key, fingerprint };
  }

  // Generate new self-signed certificate
  console.log('Generating self-signed TLS certificate...');

  const attrs = [
    { name: 'commonName', value: 'Deadhand Local' },
    { name: 'organizationName', value: 'Deadhand' },
  ];

  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365 * 5, // 5 years
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' }, // DNS
          { type: 7, ip: '127.0.0.1' }, // IP
          { type: 7, ip: '::1' }, // IPv6 localhost
        ],
      },
    ],
  });

  // Save credentials
  writeFileSync(certPath, pems.cert, { mode: 0o600 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });

  const fingerprint = computeFingerprint(pems.cert);

  console.log('TLS certificate generated and saved.');
  console.log(`Certificate fingerprint (SHA-256): ${fingerprint}`);

  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint,
  };
}


import { networkInterfaces } from 'node:os';
import { loadConfig } from './config.js';
import { loadOrGenerateTLS } from './tls.js';
import { createAuthManager } from './auth.js';
import { createInstanceRegistry } from './registry.js';
import { createPersistenceManager } from './persistence.js';
import { createServer } from './server.js';

/**
 * Get LAN IP addresses for this machine
 */
function getLanAddresses(): string[] {
  const interfaces = networkInterfaces();
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

async function main() {
  console.log('Starting Deadhand daemon...');

  const config = loadConfig();
  const tls = loadOrGenerateTLS(config.dataDir);
  const authManager = createAuthManager(config.dataDir);
  const persistence = createPersistenceManager(config.dataDir);
  const registry = createInstanceRegistry({ persistence });

  const server = await createServer({ config, tls, authManager, registry });

  // Display startup info
  const protocol = config.localhostOnly ? 'http' : 'https';
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const token = authManager.getToken();

  // Build auto-login URL with token in fragment
  const autoLoginUrl = `${protocol}://${host}:${config.port}/#token=${encodeURIComponent(token)}`;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                         DEADHAND DAEMON                          ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Web UI:     ${protocol}://${host}:${config.port}`.padEnd(67) + '║');
  console.log(`║  API:        ${protocol}://${host}:${config.port}/api/v1`.padEnd(67) + '║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Token:      ${token}`.padEnd(67) + '║');
  if (!config.localhostOnly) {
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  TLS Fingerprint (SHA-256):                                      ║');
    console.log(`║  ${tls.fingerprint}`.padEnd(67) + '║');
  }
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  ⚠️  WARNING: Transcripts may contain sensitive data!             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Print clickable auto-login URLs
  console.log('Auto-login URLs (click to open):');
  console.log(`  ${autoLoginUrl}`);
  
  // In TLS/LAN mode, also print LAN IP URLs
  if (!config.localhostOnly) {
    const lanAddresses = getLanAddresses();
    for (const ip of lanAddresses) {
      const lanUrl = `https://${ip}:${config.port}/#token=${encodeURIComponent(token)}`;
      console.log(`  ${lanUrl}  (LAN)`);
    }
  }
  console.log('');

  await server.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('Failed to start daemon:', err);
  process.exit(1);
});


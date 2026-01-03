import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonConfig } from './types.js';

const DEFAULT_PORT = 31337;
const DEFAULT_DATA_DIR = join(homedir(), '.deadhand');

export function loadConfig(): DaemonConfig {
  const localhostOnly = process.env.DEADHAND_LOCALHOST_ONLY === 'true';

  return {
    port: parseInt(process.env.DEADHAND_PORT || String(DEFAULT_PORT), 10),
    host: localhostOnly ? '127.0.0.1' : '0.0.0.0',
    dataDir: process.env.DEADHAND_DATA_DIR || DEFAULT_DATA_DIR,
    localhostOnly,
  };
}


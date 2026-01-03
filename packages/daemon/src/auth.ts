import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TOKEN_FILENAME = 'access_token';
const TOKEN_LENGTH = 32; // 256 bits

export interface AuthManager {
  getToken(): string;
  rotateToken(): string;
  validateToken(token: string | undefined): boolean;
}

/**
 * Create an auth manager that handles token storage and validation
 */
export function createAuthManager(dataDir: string): AuthManager {
  const tokenPath = join(dataDir, TOKEN_FILENAME);

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  function generateToken(): string {
    return randomBytes(TOKEN_LENGTH).toString('base64url');
  }

  function loadOrCreateToken(): string {
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf-8').trim();
    }

    const token = generateToken();
    writeFileSync(tokenPath, token, { mode: 0o600 });
    console.log('New access token generated.');
    return token;
  }

  let currentToken = loadOrCreateToken();

  return {
    getToken(): string {
      return currentToken;
    },

    rotateToken(): string {
      currentToken = generateToken();
      writeFileSync(tokenPath, currentToken, { mode: 0o600 });
      console.log('Access token rotated.');
      return currentToken;
    },

    validateToken(token: string | undefined): boolean {
      if (!token) return false;
      // Constant-time comparison to prevent timing attacks
      if (token.length !== currentToken.length) return false;
      let result = 0;
      for (let i = 0; i < token.length; i++) {
        result |= token.charCodeAt(i) ^ currentToken.charCodeAt(i);
      }
      return result === 0;
    },
  };
}


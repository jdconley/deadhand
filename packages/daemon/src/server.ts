import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import type { DaemonConfig } from './types.js';
import type { TLSCredentials } from './tls.js';
import type { AuthManager } from './auth.js';
import type { InstanceRegistry } from './registry.js';
import { createWebSocketManager } from './websocket.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  config: DaemonConfig;
  tls: TLSCredentials;
  authManager: AuthManager;
  registry: InstanceRegistry;
}

export async function createServer(options: ServerOptions) {
  const { config, tls, authManager, registry } = options;
  const wsManager = createWebSocketManager(registry, authManager);

  // Create HTTPS server for LAN, HTTP for localhost-only mode
  const serverFactory = config.localhostOnly
    ? (handler: (req: any, res: any) => void) => createHttpServer(handler)
    : (handler: (req: any, res: any) => void) =>
        createHttpsServer({ key: tls.key, cert: tls.cert }, handler);

  const app = Fastify({
    serverFactory,
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });

  // CORS for web UI
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  // WebSocket support
  await app.register(fastifyWebsocket);

  // Auth hook for API routes
  app.addHook('preHandler', async (request, reply) => {
    // Skip auth for static files and the info endpoint (used for pairing)
    if (request.url.startsWith('/api/') && !request.url.startsWith('/api/v1/info')) {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (!authManager.validateToken(token)) {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    }
  });

  // API Routes
  app.get('/api/v1/instances', async () => {
    return registry.getAllInstances();
  });

  app.get<{ Params: { instanceId: string } }>('/api/v1/instances/:instanceId', async (request, reply) => {
    const instance = registry.getInstance(request.params.instanceId);
    if (!instance) {
      return reply.code(404).send({ error: 'Instance not found' });
    }
    return instance;
  });

  app.get<{ Params: { instanceId: string } }>(
    '/api/v1/instances/:instanceId/sessions',
    async (request, reply) => {
      const instance = registry.getInstance(request.params.instanceId);
      if (!instance) {
        return reply.code(404).send({ error: 'Instance not found' });
      }
      return registry.getSessionsForInstance(request.params.instanceId);
    }
  );

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string } }>(
    '/api/v1/sessions/:sessionId',
    async (request, reply) => {
      const session = registry.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const events = registry.getTranscriptEvents(request.params.sessionId, request.query.after);
      return { session, events };
    }
  );

  // POST endpoint for sending messages to a session
  // Note: This is a fire-and-forget endpoint; the actual result comes via WebSocket
  app.post<{ Params: { sessionId: string }; Body: { message: string } }>(
    '/api/v1/sessions/:sessionId/messages',
    async (request, reply) => {
      const session = registry.getSession(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      const { message } = request.body;
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'Message is required' });
      }

      // For now, return a placeholder response
      // The actual message sending will be implemented via WebSocket
      // because we need to communicate with the extension
      return {
        accepted: true,
        sessionId: request.params.sessionId,
        note: 'Use WebSocket send_message for real-time delivery and result',
      };
    }
  );

  // Info endpoint (no auth, for pairing)
  app.get('/api/v1/info', async () => {
    return {
      name: 'deadhand',
      version: '0.1.0',
      fingerprint: config.localhostOnly ? null : tls.fingerprint,
    };
  });

  // WebSocket endpoint for clients (web UI)
  app.get('/ws', { websocket: true }, (connection, request) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    const token = url.searchParams.get('token') || undefined;
    wsManager.handleClientConnection(connection.socket, token);
  });

  // WebSocket endpoint for extensions (internal, no token required - localhost only)
  app.get('/ws/extension', { websocket: true }, (connection, request) => {
    // Only allow extension connections from localhost
    const remoteAddress = request.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      connection.socket.close(4003, 'Extension connections only allowed from localhost');
      return;
    }
    wsManager.handleExtensionConnection(connection.socket);
  });

  // Serve static web UI
  const webDistPath = join(__dirname, '../../web/dist');
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
    });

    // Fallback to index.html for SPA routing
    app.setNotFoundHandler((request, reply) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}


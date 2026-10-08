/**
 * HTTP + WebSocket server.
 *
 * Uses a single http.Server with an attached `ws` WebSocketServer in `noServer` mode, so
 * HTTP routes and WebSocket upgrades share a port. That matters on Render: one service,
 * one port, one health check, and WebSockets work because Render supports long-lived
 * connections.
 *
 * WebSocket endpoints:
 *   /twilio/media          Twilio Media Streams
 *   /ws/media              generic provider protocol
 *   /:provider/media       any registered provider
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BridgeConfig } from './config.js';
import type { Logger } from './logging.js';
import { SessionManager, SessionLimitError } from './session/manager.js';
import { createProvider, isProviderName, SUPPORTED_PROVIDERS, type ProviderName, type ProviderSocket } from './providers/index.js';
import { handleHttpRequest, type HttpContext } from './http/routes.js';

export interface BridgeServer {
  server: Server;
  sessions: SessionManager;
  listen(): Promise<number>;
  close(): Promise<void>;
  /** Exposed so a probe can record Gemini reachability for /gemini/status. */
  context: HttpContext;
}

const MEDIA_PATH = /^\/([a-z0-9_-]+)\/media$/;

export function createBridgeServer(config: BridgeConfig, logger: Logger): BridgeServer {
  const startedAt = Date.now();

  const sessions = new SessionManager({
    logger,
    maxConcurrentCalls: config.limits.maxConcurrentCalls,
    gemini: {
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      voice: config.gemini.voice,
      languageCode: config.gemini.languageCode,
      systemInstruction: '', // filled in by index.ts once the prompt is built
    },
    greeting: '',
    maxCallSeconds: config.gemini.maxCallSeconds,
    idlePromptSeconds: config.ava.idlePromptSeconds,
  });

  const context: HttpContext = { config, logger, sessions, startedAt };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const handled = await handleHttpRequest(req, res, context);
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Not found', service: 'ava-phone-bridge' }));
        }
      } catch (error) {
        logger.fail('HTTP_REQUEST', error, { path: req.url ?? '/' });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Internal error' }));
        }
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`);
    const match = MEDIA_PATH.exec(url.pathname.replace(/\/+$/, ''));

    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const providerName = match[1] as string;
    if (!isProviderName(providerName)) {
      logger.warn('PHONE_ERROR', {
        phase: 'upgrade',
        reason: 'unknown-provider',
        provider: providerName,
        supported: SUPPORTED_PROVIDERS,
      });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Origin allow-list applies to browser-initiated sockets only; telephony providers do
    // not send Origin, so an absent header is accepted.
    const origin = req.headers['origin'];
    if (config.security.allowedOrigins.length > 0 && typeof origin === 'string' && !config.security.allowedOrigins.includes(origin)) {
      logger.warn('PHONE_ERROR', { phase: 'upgrade', reason: 'origin-not-allowed', provider: providerName });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const provider = createProvider(providerName, {
      twilioAuthToken: config.security.twilioAuthToken,
      mediaToken: config.security.mediaToken,
      maxCallSeconds: config.gemini.maxCallSeconds,
    });

    const authorization = provider.authorizeMediaUpgrade(url, req.headers as Record<string, string | string[] | undefined>);
    if (!authorization.ok) {
      logger.warn('PHONE_ERROR', { phase: 'upgrade', reason: authorization.reason, provider: providerName });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void onMediaSocket(ws, req, url, providerName, provider, sessions, logger);
    });
  });

  async function onMediaSocket(
    ws: WebSocket,
    req: IncomingMessage,
    url: URL,
    providerName: ProviderName,
    provider: ReturnType<typeof createProvider>,
    manager: SessionManager,
    log: Logger,
  ): Promise<void> {
    const sessionId = manager.newSessionId();
    const query = url.searchParams;

    const connection = provider.attachMediaSocket(ws as unknown as ProviderSocket, {
      callId: query.get('callSid') ?? query.get('callId') ?? sessionId,
      provider: providerName,
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      extra: {},
    });

    try {
      await manager.createAndStart(sessionId, connection);
    } catch (error) {
      if (error instanceof SessionLimitError) {
        log.warn('PHONE_ERROR', { sessionId, provider: providerName, reason: 'concurrency-limit' });
        try {
          ws.close(1013, 'Bridge at capacity');
        } catch {
          /* ignore */
        }
        return;
      }
      log.fail('PHONE_ERROR', error, { sessionId, provider: providerName, phase: 'session-start' });
      try {
        ws.close(1011, 'Session start failed');
      } catch {
        /* ignore */
      }
      return;
    }

    // Heartbeat: drop sockets the provider has abandoned without a close frame, which
    // otherwise leak a session until the process restarts.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        log.warn('PHONE_ERROR', { sessionId, provider: providerName, reason: 'heartbeat-timeout' });
        void manager.stop(sessionId, 'heartbeat-timeout');
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, 30_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      void manager.stop(sessionId, 'socket-closed');
    };

    ws.on('close', cleanup);
    ws.on('error', (error: Error) => {
      log.fail('PHONE_ERROR', error, { sessionId, provider: providerName, phase: 'socket' });
      cleanup();
    });

    void req; // reserved for future header-based metadata
  }

  return {
    server,
    sessions,
    context,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : config.port;
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        wss.close();
        server.close(() => resolve());
      });
    },
  };
}

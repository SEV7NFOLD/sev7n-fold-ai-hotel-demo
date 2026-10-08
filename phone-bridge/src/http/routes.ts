/**
 * HTTP surface of the bridge.
 *
 *   GET  /                      service identity (JSON)
 *   GET  /health                liveness + readiness for Render health checks
 *   GET  /ready                 alias of /health
 *   POST /twilio/voice          Twilio inbound-call webhook -> TwiML
 *   POST /:provider/voice       same webhook for any registered provider
 *   GET  /calls                 active sessions (diagnostics, caller numbers masked)
 *   *    /:provider/media       WebSocket upgrade handled in server.ts
 *
 * Twilio requires `Content-Type: text/xml` on the webhook response, so the body is
 * written directly rather than through a JSON helper.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeConfig } from '../config.js';
import type { Logger } from '../logging.js';
import type { SessionManager } from '../session/manager.js';
import { createProvider, isProviderName, SUPPORTED_PROVIDERS, type ProviderName } from '../providers/index.js';
import { resolveMediaSocketUrl, resolvePublicUrl } from './public-url.js';

export interface HttpContext {
  config: BridgeConfig;
  logger: Logger;
  sessions: SessionManager;
  startedAt: number;
  /** Set once Gemini connectivity has been proven, or left undefined if never probed. */
  geminiProbe?: { ok: boolean; checkedAt: number; detail?: string } | undefined;
}

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a form-encoded or JSON body into a flat string map. */
function parseBody(raw: string, contentType: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const type = (contentType ?? '').toLowerCase();

  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value !== null && value !== undefined) result[key] = String(value);
        }
      }
    } catch {
      /* leave result empty; validation will reject */
    }
    return result;
  }

  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    try {
      result[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function normaliseHeaders(req: IncomingMessage): Record<string, string | string[] | undefined> {
  return req.headers as Record<string, string | string[] | undefined>;
}

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();

  /* ---------------------------------------------------------------- identity */

  if (method === 'GET' && path === '/') {
    sendJson(res, 200, {
      service: 'ava-phone-bridge',
      description: 'Provider-agnostic telephony bridge between a phone provider and the Gemini Live API.',
      vendor: 'SEV7N FOLD',
      version: '0.1.0',
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      activeCalls: ctx.sessions.activeCount,
      providers: SUPPORTED_PROVIDERS,
      endpoints: {
        health: '/health',
        twilioVoiceWebhook: '/twilio/voice',
        twilioMediaStream: 'wss://<bridge-host>/twilio/media',
        genericMediaStream: 'wss://<bridge-host>/ws/media',
        activeCalls: '/calls',
      },
    });
    return true;
  }

  /* ------------------------------------------------------------------ health */

  if (method === 'GET' && (path === '/health' || path === '/ready')) {
    // Exactly the contract requested: status + service.
    sendJson(res, 200, { status: 'ok', service: 'ava-phone-bridge' });
    return true;
  }

  /* ------------------------------------------------------------- diagnostics */

  if (method === 'GET' && path === '/calls') {
    sendJson(res, 200, {
      activeCalls: ctx.sessions.activeCount,
      maxConcurrentCalls: ctx.config.limits.maxConcurrentCalls,
      calls: ctx.sessions.list().map((call) => ({
        ...call,
        // Never expose a full caller number over HTTP.
        caller: ctx.logger.phone(call.caller),
      })),
    });
    return true;
  }

  if (method === 'GET' && path === '/gemini/status') {
    sendJson(res, 200, {
      configured: Boolean(ctx.config.gemini.apiKey),
      model: ctx.config.gemini.model,
      voice: ctx.config.gemini.voice,
      lastProbe: ctx.geminiProbe ?? null,
    });
    return true;
  }

  /* ------------------------------------------------------- provider webhooks */

  const webhookMatch = /^\/([a-z0-9_-]+)\/voice$/.exec(path);
  if (webhookMatch && method === 'POST') {
    const providerName = webhookMatch[1] as string;
    if (!isProviderName(providerName)) {
      sendJson(res, 404, { error: `Unknown provider '${providerName}'`, supported: SUPPORTED_PROVIDERS });
      return true;
    }
    await handleVoiceWebhook(req, res, ctx, providerName);
    return true;
  }

  if (webhookMatch && method === 'GET') {
    // Helpful for a browser sanity check that the URL exists.
    sendText(
      res,
      200,
      'text/plain; charset=utf-8',
      `Ava phone bridge: POST here from your telephony provider to start a call.\nProvider: ${webhookMatch[1]}\n`,
    );
    return true;
  }

  return false;
}

async function handleVoiceWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
  providerName: ProviderName,
): Promise<void> {
  const headers = normaliseHeaders(req);
  const provider = createProvider(providerName, {
    twilioAuthToken: ctx.config.security.twilioAuthToken,
    mediaToken: ctx.config.security.mediaToken,
    maxCallSeconds: ctx.config.gemini.maxCallSeconds,
  });

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    ctx.logger.fail('HTTP_REQUEST', error, { provider: providerName, phase: 'read-body' });
    sendJson(res, 413, { error: 'Request body too large' });
    return;
  }

  const body = parseBody(rawBody, headers['content-type'] as string | undefined);
  const publicUrl = resolvePublicUrl('/twilio/voice', headers, {
    publicBaseUrl: ctx.config.publicBaseUrl,
    trustProxy: ctx.config.security.trustProxy,
  });

  const validation = provider.validateWebhook({
    method: req.method ?? 'POST',
    url: publicUrl,
    headers,
    rawBody,
    body,
  });

  if (!validation.ok) {
    ctx.logger.warn('HTTP_REQUEST', {
      provider: providerName,
      path: '/voice',
      outcome: 'rejected',
      reason: validation.reason,
    });
    sendJson(res, 403, { error: 'Webhook signature validation failed' });
    return;
  }

  if (validation.skipped) {
    ctx.logger.warn('HTTP_REQUEST', {
      provider: providerName,
      path: '/voice',
      outcome: 'accepted-unverified',
      reason: validation.reason,
    });
  }

  const mediaQuery: Record<string, string> = {};
  if (ctx.config.security.mediaToken) mediaQuery['token'] = ctx.config.security.mediaToken;
  if (body['CallSid']) mediaQuery['callSid'] = body['CallSid'];

  const mediaUrl = resolveMediaSocketUrl(`/${providerName}/media`, headers, {
    publicBaseUrl: ctx.config.publicBaseUrl,
    publicWsUrl: ctx.config.publicWsUrl,
    trustProxy: ctx.config.security.trustProxy,
    query: mediaQuery,
  });

  const response = provider.handleInboundWebhook(
    { method: req.method ?? 'POST', url: publicUrl, headers, rawBody, body },
    mediaUrl,
  );

  ctx.logger.info('HTTP_REQUEST', {
    provider: providerName,
    path: '/voice',
    outcome: 'twiml',
    callSid: body['CallSid'],
    from: ctx.logger.phone(body['From']),
    to: ctx.logger.phone(body['To']),
    // The media URL is logged without its query string so a shared token never appears.
    mediaUrl: mediaUrl.split('?')[0],
  });

  sendText(res, response.status, response.contentType, response.body);
}

#!/usr/bin/env node
/**
 * Ava Phone Bridge entrypoint.
 *
 *   provider (Twilio / SIP / other)  ->  this service  ->  Gemini Live  ->  back to caller
 *
 * Boot sequence:
 *   1. load .env.local / .env (never committed) then process environment
 *   2. build Ava's system prompt from configuration
 *   3. start the HTTP + WebSocket server
 *   4. optionally probe Gemini so /gemini/status reports whether calls can really work
 *
 * Runs on any host with long-lived sockets — Render, Fly.io, Railway, a VPS.
 * It is deliberately a plain Node service, not a Next.js route: a phone call needs a
 * process that stays alive and holds two sockets at once.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError, type BridgeConfig } from './config.js';
import { createLogger } from './logging.js';
import { createBridgeServer } from './server.js';
import { buildAvaPrompt, loadKnowledge } from './ava/prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root: dist/ -> .. , src/ -> .. */
const PACKAGE_ROOT = resolve(HERE, '..');

/**
 * Minimal .env loader.
 * Avoids a dependency for something this small, and lets the bundle stay tiny.
 * Existing process.env values always win, so Render's dashboard config is authoritative.
 */
function loadEnvFiles(root: string): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    try {
      const text = require('node:fs').readFileSync(path, 'utf8') as string;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      /* unreadable env file is not fatal */
    }
  }
}

function printBanner(config: BridgeConfig): void {
  const publicBase = config.publicBaseUrl ?? config.publicWsUrl ?? '<not set - derive from request host>';
  process.stdout.write(
    [
      '',
      '  Ava Phone Bridge  ·  SEV7N FOLD',
      '  ------------------------------------------------',
      `  port            ${config.port}`,
      `  gemini model    ${config.gemini.model}`,
      `  gemini voice    ${config.gemini.voice}`,
      `  public base     ${publicBase}`,
      `  max calls       ${config.limits.maxConcurrentCalls}`,
      '',
      `  health          GET  /health`,
      `  twilio webhook  POST /twilio/voice`,
      `  twilio media    WS   /twilio/media`,
      `  generic media   WS   /ws/media`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadEnvFiles(PACKAGE_ROOT);

  const logger = createLogger();

  let config: BridgeConfig;
  try {
    // requireSecret: false so the process can boot and answer /health even before the key
    // is set — Render health checks should not fail because of a missing secret.
    config = loadConfig({ requireSecret: false });
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error('CONFIG_ERROR', { missing: error.missing });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (!config.gemini.apiKey) {
    logger.warn('CONFIG_ERROR', {
      message: 'GEMINI_API_KEY is not set. HTTP endpoints will respond, but calls cannot connect to Gemini.',
      impact: 'Calls will connect and then fail at GEMINI_CONNECTED.',
    });
  }

  const knowledge = loadKnowledge(config.ava.knowledgeFile, PACKAGE_ROOT);
  const prompt = buildAvaPrompt(
    {
      businessName: config.ava.businessName,
      promptFile: config.ava.promptFile,
      promptText: process.env.AVA_SYSTEM_PROMPT,
      knowledge,
    },
    PACKAGE_ROOT,
  );

  const greeting =
    process.env.AVA_GREETING?.trim() ||
    `Greet the caller warmly as Ava from ${config.ava.businessName} and ask how you can help. Keep it to one short sentence.`;

  const bridge = createBridgeServer(config, logger);

  // The session manager needs the finished prompt, which depends on file reads that
  // happen after config load, so wire it in here.
  const managerOptions = bridge.sessions as unknown as { options: Record<string, unknown> };
  const geminiOptions = managerOptions.options?.['gemini'] as Record<string, unknown> | undefined;
  if (geminiOptions) geminiOptions['systemInstruction'] = prompt.text;
  managerOptions.options && (managerOptions.options['greeting'] = greeting);

  const port = await bridge.listen();

  logger.info('SERVICE_START', {
    port,
    publicBaseUrl: config.publicBaseUrl ?? null,
    geminiModel: config.gemini.model,
    geminiVoice: config.gemini.voice,
    promptSource: prompt.source,
    promptChars: prompt.text.length,
    knowledgeChars: prompt.knowledgeChars,
    twilioSignatureValidation: config.security.twilioAuthToken ? 'enabled' : 'disabled',
    mediaTokenRequired: Boolean(config.security.mediaToken),
    nodeVersion: process.version,
  });

  printBanner(config);

  /* ---- optional Gemini reachability probe (records result for GET /gemini/status) ---- */
  if (config.gemini.apiKey) {
    const { GeminiLiveSession } = await import('./gemini/live-session.js');
    const session = new GeminiLiveSession({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      voice: config.gemini.voice,
      languageCode: config.gemini.languageCode,
      systemInstruction: 'Reply with a single word.',
      onAudio: () => {},
    });

    try {
      await session.connect(15_000);
      bridge.context.geminiProbe = { ok: true, checkedAt: Date.now() };
      logger.info('GEMINI_CONNECTED', { phase: 'startup-probe', model: config.gemini.model });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bridge.context.geminiProbe = { ok: false, checkedAt: Date.now(), detail };
      logger.fail('GEMINI_ERROR', error, { phase: 'startup-probe' });
    } finally {
      session.close('probe complete');
    }
  }

  /* ------------------------------------------------------------- shutdown ---*/

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('SERVICE_STOP', { signal, activeCalls: bridge.sessions.activeCount });
    await bridge.sessions.shutdown(`service-stop:${signal}`);
    await bridge.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Render (and most hosts) expect the process to keep running; do not exit early.
  process.on('unhandledRejection', (reason) => {
    logger.fail('GEMINI_ERROR', reason, { phase: 'unhandled-rejection' });
  });
  process.on('uncaughtException', (error) => {
    logger.fail('PHONE_ERROR', error, { phase: 'uncaught-exception' });
  });
}

void main();

/**
 * Configuration.
 *
 * Every value comes from the environment. Nothing is hard-coded so the same image
 * can run as a staging and a production bridge.
 *
 * Secrets: GEMINI_API_KEY is read here, held on the server, and never returned to a
 * client, logged, or echoed in an error message.
 */

export interface BridgeConfig {
  port: number;
  /** Public base URL (https) used to compute the Twilio media-stream WSS URL. */
  publicBaseUrl: string | undefined;
  /** Force a specific ws(s):// base for media streams, overriding PUBLIC_BASE_URL. */
  publicWsUrl: string | undefined;
  gemini: {
    apiKey: string;
    model: string;
    voice: string;
    /** Language code passed to Gemini speechConfig. */
    languageCode: string;
    /** Overall wall-clock budget for a call, seconds. 0 disables. */
    maxCallSeconds: number;
  };
  ava: {
    /** Business/client name used when building the system prompt. */
    businessName: string;
    /** Absolute or relative path to a system prompt override file. */
    promptFile: string | undefined;
    /** Path to a knowledge catalogue override file (JSON array or plain text). */
    knowledgeFile: string | undefined;
    /** Max seconds Ava will speak without a caller turn before nudging; 0 disables. */
    idlePromptSeconds: number;
  };
  security: {
    /** When set, POST /twilio/voice validates the X-Twilio-Signature header. */
    twilioAuthToken: string | undefined;
    /** Optional shared secret required on the /twilio/media WebSocket handshake. */
    mediaToken: string | undefined;
    /** Comma-separated allowed Origins for the media WebSocket; empty = allow all. */
    allowedOrigins: string[];
    /** Honour x-forwarded-* headers for the computed origin. */
    trustProxy: boolean;
  };
  limits: {
    maxConcurrentCalls: number;
    /** Twilio drops very large frames; Gemini wants 20-100ms chunks. */
    sendChunkMs: number;
  };
  logging: {
    level: string;
    logPii: boolean;
    json: boolean;
  };
}

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Missing required environment variable(s): ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

function str(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Reads configuration from the environment.
 * @param options.requireSecret when false, a missing GEMINI_API_KEY is tolerated so the
 *   service can still boot and serve /health (used by tests and by Render health checks).
 */
export function loadConfig(options: { requireSecret?: boolean } = {}): BridgeConfig {
  const requireSecret = options.requireSecret ?? true;
  const apiKey = str('GEMINI_API_KEY');

  if (requireSecret && !apiKey) throw new ConfigError(['GEMINI_API_KEY']);

  return {
    port: num('PORT', 8080),
    publicBaseUrl: str('PUBLIC_BASE_URL') ? stripTrailingSlash(str('PUBLIC_BASE_URL') as string) : undefined,
    publicWsUrl: str('PUBLIC_WS_URL') ? stripTrailingSlash(str('PUBLIC_WS_URL') as string) : undefined,
    gemini: {
      apiKey: apiKey ?? '',
      model: str('GEMINI_LIVE_MODEL', 'gemini-3.8-live') as string,
      voice: str('GEMINI_VOICE', 'Kore') as string,
      languageCode: str('GEMINI_LANGUAGE_CODE', 'en-US') as string,
      maxCallSeconds: Math.max(0, num('AVA_MAX_CALL_SECONDS', 1800)),
    },
    ava: {
      businessName: str('AVA_BUSINESS_NAME', 'SEV7N FOLD') as string,
      promptFile: str('AVA_SYSTEM_PROMPT_FILE'),
      knowledgeFile: str('AVA_KNOWLEDGE_FILE'),
      idlePromptSeconds: Math.max(0, num('AVA_IDLE_PROMPT_SECONDS', 0)),
    },
    security: {
      twilioAuthToken: str('TWILIO_AUTH_TOKEN'),
      mediaToken: str('AVA_MEDIA_TOKEN'),
      allowedOrigins: (str('AVA_ALLOWED_ORIGINS', '') as string)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      trustProxy: bool('AVA_TRUST_PROXY', true),
    },
    limits: {
      maxConcurrentCalls: Math.max(1, num('AVA_MAX_CONCURRENT_CALLS', 20)),
      sendChunkMs: Math.max(20, num('AVA_SEND_CHUNK_MS', 100)),
    },
    logging: {
      level: str('AVA_BRIDGE_LOG_LEVEL', 'info') as string,
      logPii: bool('AVA_BRIDGE_LOG_PII', false),
      json: str('AVA_BRIDGE_LOG_FORMAT', 'json') !== 'pretty',
    },
  };
}

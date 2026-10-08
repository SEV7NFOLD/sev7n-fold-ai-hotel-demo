/**
 * Structured logging.
 *
 * Rules enforced here:
 *  - Never log secret material. `redactSecrets` scrubs anything that looks like a
 *    credential out of a log payload, and error objects are reduced to
 *    name/message/code rather than dumped.
 *  - Never log conversation content. Transcript text is never passed to the logger;
 *    only counts, byte sizes, durations and identifiers.
 *  - Caller phone numbers are personal data. They are masked by default and only
 *    logged in full when AVA_BRIDGE_LOG_PII=true.
 */

export const LOG_EVENTS = [
  'SERVICE_START',
  'SERVICE_STOP',
  'HTTP_REQUEST',
  'CALL_CONNECTED',
  'GEMINI_CONNECTED',
  'AUDIO_STARTED',
  'AUDIO_FLOW',
  'CALL_ENDED',
  'CALL_CLEANUP',
  'GEMINI_ERROR',
  'PHONE_ERROR',
  'CONFIG_ERROR',
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never logged, whatever they contain. */
const FORBIDDEN_KEY = /(api[-_]?key|authorization|token|secret|password|credential|passwd|bearer)/i;

/** Substrings that identify secret-looking values we should scrub defensively. */
const SECRET_VALUE = /(AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S+|Basic\s+\S+|AC[0-9a-f]{30,}|SK[0-9a-f]{30,})/g;

export interface LoggerOptions {
  level: LogLevel;
  /** When true, PII such as caller numbers is logged in full. Default false. */
  logPii: boolean;
  /** When true, emits JSON lines; otherwise a human-readable line. */
  json: boolean;
}

export interface LogFields {
  [key: string]: unknown;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return redactSecrets(value as Record<string, unknown>);
  return value;
}

/** Recursively drop or scrub anything that could carry a secret. */
export function redactSecrets(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

/** Reduce an unknown thrown value to safe, useful fields. Never includes a stack in production logs. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string | number; cause?: unknown };
    const described: LogFields = { name: error.name, message: error.message };
    if (withCode.code !== undefined) described.code = withCode.code;
    if (withCode.cause instanceof Error) described.cause = withCode.cause.message;
    return described;
  }
  if (typeof error === 'string') return { name: 'Error', message: error };
  return { name: 'UnknownError', message: String(error) };
}

/**
 * Mask a phone number for logs: keep the country code and last two digits.
 * `+2348012345678` -> `+234******78`
 */
export function maskPhoneNumber(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^\d+]/g, '');
  if (digits.length < 5) return '***';
  const plus = digits.startsWith('+') ? '+' : '';
  const body = plus ? digits.slice(1) : digits;
  if (body.length <= 4) return `${plus}***`;
  return `${plus}${body.slice(0, 3)}${'*'.repeat(Math.max(0, body.length - 5))}${body.slice(-2)}`;
}

export class Logger {
  private readonly options: LoggerOptions;

  constructor(options: LoggerOptions) {
    this.options = options;
  }

  private write(level: LogLevel, event: LogEvent, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.options.level]) return;

    const safe = redactSecrets(fields);
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      service: 'ava-phone-bridge',
      ...safe,
    };

    const line = this.options.json
      ? JSON.stringify(record)
      : `${record.ts} ${level.toUpperCase().padEnd(5)} ${event}${
          Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ''
        }`;

    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(event: LogEvent, fields?: LogFields): void {
    this.write('debug', event, fields);
  }

  info(event: LogEvent, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: LogEvent, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: LogEvent, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  /** Log an error event with a sanitised error payload. */
  fail(event: LogEvent, error: unknown, fields: LogFields = {}): void {
    this.write('error', event, { ...fields, error: describeError(error) });
  }

  /** Mask a phone number according to the PII setting. */
  phone(value: string | undefined | null): string | undefined {
    return this.options.logPii ? value ?? undefined : maskPhoneNumber(value);
  }
}

export function createLogger(options: Partial<LoggerOptions> = {}): Logger {
  const level = (options.level ?? (process.env.AVA_BRIDGE_LOG_LEVEL as LogLevel) ?? 'info') as LogLevel;
  return new Logger({
    level: LEVEL_RANK[level] ? level : 'info',
    logPii: options.logPii ?? process.env.AVA_BRIDGE_LOG_PII === 'true',
    json: options.json ?? process.env.AVA_BRIDGE_LOG_FORMAT !== 'pretty',
  });
}

/**
 * Twilio Programmable Voice adapter.
 *
 * Two halves:
 *   POST /twilio/voice  -> TwiML instructing Twilio to open a bidirectional Media Stream
 *   WS   /twilio/media  -> the Media Streams protocol itself
 *
 * Media Streams wire protocol (Twilio -> us):
 *   { "event": "connected", "protocol": "Call", "version": "1.0.0" }
 *   { "event": "start", "start": { "streamSid", "callSid", "accountSid",
 *                                  "tracks": ["inbound"], "mediaFormat": {
 *                                    "encoding": "audio/x-mulaw", "sampleRate": 8000,
 *                                    "channels": 1 },
 *                                  "customParameters": { "from": "+1...", "to": "+1..." } } }
 *   { "event": "media", "streamSid", "media": { "track": "inbound", "chunk": "1",
 *                                               "timestamp": "5", "payload": "<base64 μ-law>" } }
 *   { "event": "dtmf",  "dtmf": { "digit": "1" } }
 *   { "event": "mark",  "mark": { "name": "..." } }
 *   { "event": "stop",  "stop": { "accountSid", "callSid" } }
 *
 * Us -> Twilio:
 *   { "event": "media", "streamSid": "...", "media": { "payload": "<base64 μ-law>" } }
 *   { "event": "clear", "streamSid": "..." }              <- barge-in
 *   { "event": "mark",  "streamSid": "...", "mark": { "name": "..." } }
 *
 * Audio is μ-law 8 kHz mono in both directions, which is exactly what the bridge's
 * audio pipeline expects, so this adapter does no conversion of its own.
 *
 * NOTE ON TWILIO TRIAL ACCOUNTS: a trial account may refuse to save an inbound voice
 * webhook (TwiML App / phone number configuration can require an upgraded account).
 * This adapter is written to the documented protocol and is ready for a compatible
 * account; it does not depend on trial-only behaviour.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PhoneProvider,
  ProviderCallMeta,
  ProviderConnection,
  ProviderInfo,
  ProviderSocket,
  WebhookRequest,
  WebhookResponse,
  WebhookValidation,
} from './types.js';
import { SOCKET_OPEN } from './types.js';

const TWILIO_INFO: ProviderInfo = {
  name: 'twilio',
  description: 'Twilio Programmable Voice + Media Streams (μ-law 8 kHz, bidirectional)',
  inputSampleRate: 8000,
  outputSampleRate: 8000,
  encoding: 'mulaw',
};

interface TwilioStartPayload {
  streamSid?: string;
  callSid?: string;
  accountSid?: string;
  tracks?: string[];
  customParameters?: Record<string, string>;
  mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
}

/** Escape a string for safe inclusion in XML text/attribute content. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TwilioAdapterOptions {
  authToken?: string | undefined;
  /** Maximum call length in seconds; 0 omits the limit. */
  maxCallSeconds?: number;
  /** Text spoken if the media stream cannot be established. */
  fallbackSay?: string;
}

export class TwilioProvider implements PhoneProvider {
  readonly name = 'twilio';
  readonly info = TWILIO_INFO;

  private readonly options: TwilioAdapterOptions;

  constructor(options: TwilioAdapterOptions = {}) {
    this.options = options;
  }

  /**
   * Build the TwiML that connects the inbound call to our Media Stream.
   *
   * `<Connect><Stream>` is bidirectional: Twilio sends caller audio to us and plays
   * whatever μ-law frames we send back. `<Start><Stream>` would be one-way and is not
   * what we want.
   */
  handleInboundWebhook(_request: WebhookRequest, mediaUrl: string): WebhookResponse {
    const maxCallSeconds = this.options.maxCallSeconds ?? 0;
    const fallback = this.options.fallbackSay ?? 'Sorry, our voice assistant is unavailable right now. Please try again shortly.';

    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Connect>',
      `    <Stream url="${escapeXml(mediaUrl)}" />`,
      '  </Connect>',
    ];

    if (maxCallSeconds > 0) lines.push(`  <Dial timeLimit="${maxCallSeconds}"><Number /></Dial>`);
    // If the stream ends without the call being hung up, speak a short close then hang up.
    lines.push(`  <Say voice="Polly.Joanna">${escapeXml(fallback)}</Say>`);
    lines.push('  <Hangup />', '</Response>');

    return {
      status: 200,
      contentType: 'text/xml; charset=utf-8',
      body: lines.join('\n'),
    };
  }

  /**
   * Validate Twilio's `X-Twilio-Signature`.
   *
   * Twilio signs the full request URL with every POST parameter sorted by key and
   * appended as key+value, HMAC-SHA1 with the account Auth Token, base64 encoded.
   *
   * If no Auth Token is configured the check is reported as skipped rather than failed,
   * so the bridge can run locally without a Twilio account — the caller logs a warning.
   */
  validateWebhook(request: WebhookRequest): WebhookValidation {
    const authToken = this.options.authToken;
    if (!authToken) {
      return { ok: true, skipped: true, reason: 'TWILIO_AUTH_TOKEN is not set; signature validation skipped' };
    }

    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return { ok: false, reason: 'Missing X-Twilio-Signature header' };

    const params = Object.keys(request.body).sort();
    let payload = request.url;
    for (const key of params) payload += key + (request.body[key] ?? '');

    const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== actualBuf.length) return { ok: false, reason: 'Signature mismatch' };
    if (!timingSafeEqual(expectedBuf, actualBuf)) return { ok: false, reason: 'Signature mismatch' };

    return { ok: true };
  }

  /**
   * Gate the media WebSocket upgrade.
   * Twilio does not send a shared secret on the media socket, so the only defence is the
   * URL itself: the bridge can require `?token=` when AVA_MEDIA_TOKEN is configured.
   */
  authorizeMediaUpgrade(url: URL): WebhookValidation {
    return { ok: true, skipped: true, reason: `twilio media upgrade for stream ${url.searchParams.get('stream') ?? 'unknown'}` };
  }

  /** Wrap an accepted WebSocket in the Twilio Media Streams protocol. */
  attachMediaSocket(socket: ProviderSocket, initialMeta: ProviderCallMeta): ProviderConnection {
    return new TwilioConnection(socket, initialMeta);
  }
}

class TwilioConnection implements ProviderConnection {
  readonly info = TWILIO_INFO;
  meta: ProviderCallMeta;

  private readonly socket: ProviderSocket;
  private streamSid: string | undefined;
  private closed = false;
  private started = false;

  private startHandler: ((meta: ProviderCallMeta) => void) | undefined;
  private audioHandler: ((payload: Uint8Array) => void) | undefined;
  private stopHandler: (() => void) | undefined;
  private errorHandler: ((error: Error) => void) | undefined;

  constructor(socket: ProviderSocket, meta: ProviderCallMeta) {
    this.socket = socket;
    this.meta = meta;

    socket.on('message', (data: unknown, isBinary: boolean) => this.handleMessage(data, isBinary));
    socket.on('close', () => {
      this.closed = true;
      this.stopHandler?.();
    });
    socket.on('error', (error: Error) => {
      this.errorHandler?.(error);
    });
  }

  onStart(handler: (meta: ProviderCallMeta) => void): void {
    this.startHandler = handler;
  }

  onAudio(handler: (payload: Uint8Array) => void): void {
    this.audioHandler = handler;
  }

  onStop(handler: () => void): void {
    this.stopHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private handleMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) return; // Media Streams is JSON-only on the control channel.

    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString('utf8');
    else return;

    let message: {
      event?: string;
      streamSid?: string;
      start?: TwilioStartPayload;
      media?: { track?: string; payload?: string };
      stop?: { callSid?: string };
      dtmf?: { digit?: string };
      mark?: { name?: string };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      this.errorHandler?.(new Error('Twilio sent an unparseable media-stream message'));
      return;
    }

    switch (message.event) {
      case 'connected':
        // Protocol handshake; nothing to do until `start` arrives.
        break;

      case 'start': {
        const start = message.start ?? {};
        this.streamSid = start.streamSid ?? message.streamSid;
        this.started = true;
        const params = start.customParameters ?? {};
        this.meta = {
          ...this.meta,
          callId: start.callSid ?? this.meta.callId,
          from: params['from'] ?? this.meta.from,
          to: params['to'] ?? this.meta.to,
          extra: {
            ...(this.meta.extra ?? {}),
            ...(start.accountSid ? { accountSid: start.accountSid } : {}),
            ...(this.streamSid ? { streamSid: this.streamSid } : {}),
            ...(start.mediaFormat?.encoding ? { encoding: start.mediaFormat.encoding } : {}),
            ...(start.mediaFormat?.sampleRate ? { sampleRate: String(start.mediaFormat.sampleRate) } : {}),
          },
        };
        this.startHandler?.(this.meta);
        break;
      }

      case 'media': {
        const payload = message.media?.payload;
        // Ignore the outbound track if a provider ever echoes it back to us.
        if (!payload || (message.media?.track && message.media.track !== 'inbound')) break;
        if (this.streamSid === undefined && message.streamSid) this.streamSid = message.streamSid;
        this.audioHandler?.(Buffer.from(payload, 'base64'));
        break;
      }

      case 'stop':
        this.closed = true;
        this.stopHandler?.();
        break;

      case 'dtmf':
        // Keypad input is intentionally not fed to Ava; exposed for future use.
        break;

      case 'mark':
        break;

      default:
        break;
    }
  }

  sendAudio(ulaw8k: Uint8Array): void {
    if (this.closed || !this.streamSid || this.socket.readyState !== SOCKET_OPEN) return;
    this.send({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: Buffer.from(ulaw8k.buffer, ulaw8k.byteOffset, ulaw8k.byteLength).toString('base64') },
    });
  }

  sendMessage(message: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    this.send(message);
  }

  /** Barge-in: Twilio discards everything it has buffered but not yet played. */
  clear(): void {
    if (this.closed || !this.streamSid || this.socket.readyState !== SOCKET_OPEN) return;
    this.send({ event: 'clear', streamSid: this.streamSid });
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      /* socket already gone */
    }
  }

  isClosed(): boolean {
    return this.closed || this.socket.readyState !== SOCKET_OPEN;
  }

  /** Exposed for tests and diagnostics. */
  hasStarted(): boolean {
    return this.started;
  }
}

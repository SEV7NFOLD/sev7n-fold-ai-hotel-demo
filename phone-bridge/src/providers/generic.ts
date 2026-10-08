/**
 * Generic / bring-your-own-provider adapter.
 *
 * Purpose: prove the architecture is not Twilio-shaped, and give us something to point
 * a future SIP gateway or CPaaS at without writing a new adapter from scratch.
 *
 * Protocol (documented so a provider integrator can implement it):
 *
 *   WebSocket  /ws/media?callId=<id>&from=<e164>&to=<e164>&token=<optional>
 *
 *   Provider -> bridge (JSON text frames):
 *     { "type": "start",  "callId": "...", "from": "...", "to": "...", "encoding": "mulaw"|"pcm16",
 *                          "sampleRate": 8000 }
 *     { "type": "audio",  "payload": "<base64>" }        // audio in the declared encoding
 *     { "type": "stop" }
 *
 *   Bridge -> provider (JSON text frames):
 *     { "type": "ready" }                                 // sent once Gemini is live
 *     { "type": "audio", "payload": "<base64 μ-law 8 kHz>" }
 *     { "type": "clear" }                                 // barge-in
 *     { "type": "end",   "reason": "..." }
 *
 * Audio is normalised to μ-law 8 kHz on the way out, matching the telephony pipeline.
 * If a provider declares `encoding: "pcm16"`, inbound frames are converted from PCM16 to
 * μ-law internally so the rest of the bridge only ever deals with one format.
 */

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
import { pcm16BytesToUlaw, resamplePcm16Bytes, ulawToPcm16Bytes } from '../audio/index.js';

const GENERIC_INFO: ProviderInfo = {
  name: 'generic',
  description: 'Generic WebSocket telephony provider (base64 μ-law 8 kHz, or PCM16 with declared rate)',
  inputSampleRate: 8000,
  outputSampleRate: 8000,
  encoding: 'mulaw',
};

export interface GenericAdapterOptions {
  /** Shared secret required on the media socket when set. */
  mediaToken?: string | undefined;
  /** URL the webhook should point a provider at, if this adapter is used for signalling. */
  mediaPath?: string;
}

export class GenericProvider implements PhoneProvider {
  readonly name = 'generic';
  readonly info = GENERIC_INFO;

  private readonly options: GenericAdapterOptions;

  constructor(options: GenericAdapterOptions = {}) {
    this.options = options;
  }

  /**
   * There is no standard inbound-call signalling in the generic protocol, so the webhook
   * returns a machine-readable description of the endpoint to use instead of TwiML.
   */
  handleInboundWebhook(_request: WebhookRequest, mediaUrl: string): WebhookResponse {
    return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          provider: 'generic',
          message: 'Generic provider adapter. Open the media WebSocket to stream call audio.',
          mediaUrl,
          protocol: {
            inbound: [
              { type: 'start', callId: 'string', from: 'string?', to: 'string?', encoding: 'mulaw|pcm16', sampleRate: 'number?' },
              { type: 'audio', payload: 'base64' },
              { type: 'stop' },
            ],
            outbound: [
              { type: 'ready' },
              { type: 'audio', payload: 'base64 μ-law 8 kHz' },
              { type: 'clear' },
              { type: 'end', reason: 'string' },
            ],
          },
        },
        null,
        2,
      ),
    };
  }

  validateWebhook(_request: WebhookRequest): WebhookValidation {
    return { ok: true, skipped: true, reason: 'Generic provider has no webhook signature scheme' };
  }

  authorizeMediaUpgrade(url: URL): WebhookValidation {
    const expected = this.options.mediaToken;
    if (!expected) return { ok: true, skipped: true, reason: 'AVA_MEDIA_TOKEN is not set; media token check skipped' };
    const provided = url.searchParams.get('token');
    if (provided === expected) return { ok: true };
    return { ok: false, reason: 'Invalid or missing media token' };
  }

  attachMediaSocket(socket: ProviderSocket, meta: ProviderCallMeta): ProviderConnection {
    return new GenericConnection(socket, meta);
  }
}

class GenericConnection implements ProviderConnection {
  readonly info = GENERIC_INFO;
  meta: ProviderCallMeta;

  private readonly socket: ProviderSocket;
  private closed = false;
  /** Inbound encoding as declared by the provider in its `start` frame. */
  private inboundEncoding: 'mulaw' | 'pcm16' = 'mulaw';
  private inboundRate = 8000;

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
    socket.on('error', (error: Error) => this.errorHandler?.(error));
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
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString('utf8');
    else return;

    if (isBinary) {
      // Raw binary frames are treated as μ-law 8 kHz, which is the documented default.
      this.audioHandler?.(new Uint8Array(Buffer.from(text, 'binary')));
      return;
    }

    let message: {
      type?: string;
      callId?: string;
      from?: string;
      to?: string;
      encoding?: string;
      sampleRate?: number;
      payload?: string;
      reason?: string;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      this.errorHandler?.(new Error('Generic provider sent an unparseable message'));
      return;
    }

    switch (message.type) {
      case 'start':
        if (message.encoding === 'pcm16' || message.encoding === 'mulaw') this.inboundEncoding = message.encoding;
        if (typeof message.sampleRate === 'number' && message.sampleRate > 0) this.inboundRate = message.sampleRate;
        this.meta = {
          ...this.meta,
          callId: message.callId ?? this.meta.callId,
          from: message.from ?? this.meta.from,
          to: message.to ?? this.meta.to,
          extra: { ...(this.meta.extra ?? {}), encoding: this.inboundEncoding, sampleRate: String(this.inboundRate) },
        };
        this.startHandler?.(this.meta);
        break;

      case 'audio': {
        if (!message.payload) break;
        const raw = new Uint8Array(Buffer.from(message.payload, 'base64'));
        this.audioHandler?.(this.normaliseInbound(raw));
        break;
      }

      case 'stop':
        this.closed = true;
        this.stopHandler?.();
        break;

      default:
        break;
    }
  }

  /** Convert whatever the provider declared into μ-law 8 kHz, the bridge's internal format. */
  private normaliseInbound(raw: Uint8Array): Uint8Array {
    if (this.inboundEncoding === 'mulaw' && this.inboundRate === 8000) return raw;
    if (this.inboundEncoding === 'mulaw') {
      const pcm = ulawToPcm16Bytes(raw);
      return pcm16BytesToUlaw(resamplePcm16Bytes(pcm, this.inboundRate, 8000));
    }
    const pcm = resamplePcm16Bytes(raw, this.inboundRate, 8000);
    return pcm16BytesToUlaw(pcm);
  }

  sendAudio(ulaw8k: Uint8Array): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    this.send({ type: 'audio', payload: Buffer.from(ulaw8k.buffer, ulaw8k.byteOffset, ulaw8k.byteLength).toString('base64') });
  }

  sendMessage(message: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    this.send(message);
  }

  clear(): void {
    if (this.closed || this.socket.readyState !== SOCKET_OPEN) return;
    this.send({ type: 'clear' });
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
      if (this.socket.readyState === SOCKET_OPEN) this.send({ type: 'end', reason });
    } catch {
      /* ignore */
    }
    try {
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      /* socket already gone */
    }
  }

  isClosed(): boolean {
    return this.closed || this.socket.readyState !== SOCKET_OPEN;
  }
}

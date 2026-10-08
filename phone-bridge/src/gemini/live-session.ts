/**
 * Gemini Live client for phone calls.
 *
 * Mirrors the browser implementation in components/voice/useGeminiLive.ts but runs on the
 * server, which is the key architectural difference for telephony: the phone cannot hold
 * the socket, so the bridge does.
 *
 * Auth model
 * ----------
 * The browser path mints a short-lived single-use token via /api/gemini/live-token so the
 * API key never reaches the client. Server-to-server there is no such need, so the bridge
 * authenticates the WebSocket with the API key in the `x-goog-api-key` header and the key
 * never leaves this process.
 *
 * Message flow
 * ------------
 *   us  -> setup               { model, generationConfig, systemInstruction, transcriptions }
 *   gem -> setupComplete
 *   us  -> realtimeInput.audio { data: base64 PCM16 16 kHz }
 *   gem -> serverContent.modelTurn.parts[].inlineData.data  (base64 PCM16 24 kHz)
 *   gem -> serverContent.inputTranscription / outputTranscription
 *   gem -> serverContent.interrupted      (barge-in)
 *   gem -> serverContent.turnComplete
 *   gem -> goAway / error
 *
 * This module is transport-only: it emits callbacks and knows nothing about Twilio.
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { base64ToBytes, bytesToBase64 } from '../audio/index.js';

export const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export type GeminiStatus = 'IDLE' | 'CONNECTING' | 'READY' | 'CLOSED' | 'ERROR';

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  languageCode?: string;
  systemInstruction: string;
  /** Called with base64 PCM16 24 kHz audio from Ava. */
  onAudio: (base64Pcm24k: string) => void;
  /** Called with recognised caller speech. Not logged by the bridge. */
  onCallerTranscript?: (text: string) => void;
  /** Called with Ava's spoken text. Not logged by the bridge. */
  onAvaTranscript?: (text: string) => void;
  /** Barge-in: the caller started talking over Ava. */
  onInterrupted?: () => void;
  /** A complete Ava turn has finished. */
  onTurnComplete?: () => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
  /** Injectable for tests. */
  socketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface GeminiPacket {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: unknown;
  goAway?: { timeLeft?: string };
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiLiveSession extends EventEmitter {
  private readonly options: GeminiLiveOptions;
  private socket: WebSocket | undefined;
  private status: GeminiStatus = 'IDLE';
  private closed = false;
  private readyAt: number | undefined;
  private audioChunksIn = 0;
  private audioChunksOut = 0;

  constructor(options: GeminiLiveOptions) {
    super();
    this.options = options;
  }

  getStatus(): GeminiStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status === 'READY' && this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
  }

  getStats(): { audioChunksIn: number; audioChunksOut: number; readyAt: number | undefined } {
    return { audioChunksIn: this.audioChunksIn, audioChunksOut: this.audioChunksOut, readyAt: this.readyAt };
  }

  /** Open the socket and send `setup`. Resolves once `setupComplete` is received. */
  connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket) return Promise.reject(new Error('Gemini session already started'));

    const url = `${GEMINI_WS_BASE}?alt=websocket`;
    const headers: Record<string, string> = { 'x-goog-api-key': this.options.apiKey };

    return new Promise<void>((resolve, reject) => {
      this.status = 'CONNECTING';

      const socket = this.options.socketFactory
        ? this.options.socketFactory(url, headers)
        : new WebSocket(url, { headers });

      this.socket = socket;

      const timeout = setTimeout(() => {
        if (this.status !== 'READY') {
          this.fail(new Error('Timed out waiting for Gemini to complete session setup'));
          reject(new Error('Gemini setup timeout'));
        }
      }, timeoutMs);

      const settle = (error?: Error): void => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };

      socket.on('open', () => {
        this.sendSetup();
      });

      socket.on('message', (data: unknown) => {
        // Handlers are wrapped so a failure inside the bridge can never surface as an
        // unhandled 'error' event on the WebSocket and take the process down mid-call.
        void this.handleMessage(data, settle).catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      });

      socket.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.fail(error);
        reject(error);
      });

      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        const reasonText = reason?.toString('utf8') ?? '';
        if (this.status !== 'READY') {
          const error = new Error(`Gemini closed the socket before setup completed (code ${code})`);
          this.fail(error);
          reject(error);
          return;
        }
        this.status = 'CLOSED';
        this.closed = true;
        this.options.onClose?.(code, reasonText);
        this.emit('close', code, reasonText);
      });
    });
  }

  private sendSetup(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(
      JSON.stringify({
        setup: {
          model: `models/${this.options.model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              languageCode: this.options.languageCode ?? 'en-US',
              voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voice } },
            },
          },
          systemInstruction: { parts: [{ text: this.options.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }),
    );
  }

  private async handleMessage(data: unknown, settle: (error?: Error) => void): Promise<void> {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString('utf8');
    else if (typeof (data as { text?: unknown }).text === 'function') {
      text = await (data as { text: () => Promise<string> }).text();
    } else if (typeof (data as { toString?: unknown }).toString === 'function' && data !== null) {
      // A Blob or Buffer-like frame.
      text = String(data);
    } else {
      this.fail(new Error('Gemini sent a frame in an unsupported format'));
      return;
    }

    let packet: GeminiPacket;
    try {
      packet = JSON.parse(text) as GeminiPacket;
    } catch {
      this.fail(new Error('Gemini sent an unparseable frame'));
      return;
    }

    if (packet.error) {
      const error = new Error(`Gemini error ${packet.error.code ?? ''}: ${packet.error.message ?? 'unknown'}`.trim());
      this.fail(error);
      settle(error);
      return;
    }

    if (packet.setupComplete) {
      this.status = 'READY';
      this.readyAt = Date.now();
      this.options.onReady?.();
      this.emit('ready');
      settle();
      return;
    }

    if (packet.goAway) {
      // Gemini is about to end the session. Surface it so the call can be closed cleanly
      // rather than dropping mid-sentence.
      this.emit('goAway', packet.goAway.timeLeft);
      return;
    }

    const content = packet.serverContent;
    if (!content) return;

    if (content.inputTranscription?.text) this.options.onCallerTranscript?.(content.inputTranscription.text);
    if (content.outputTranscription?.text) this.options.onAvaTranscript?.(content.outputTranscription.text);

    if (content.interrupted) {
      this.options.onInterrupted?.();
      this.emit('interrupted');
    }

    const parts = content.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        const audio = part.inlineData?.data;
        if (!audio) continue;
        this.audioChunksOut += 1;
        this.options.onAudio(audio);
      }
    }

    if (content.turnComplete) {
      this.options.onTurnComplete?.();
      this.emit('turnComplete');
    }
  }

  /** Send caller audio. `pcm16_16k` is raw little-endian PCM16 at 16 kHz. */
  sendAudio(pcm16_16k: Uint8Array): void {
    if (!this.isReady() || this.closed) return;
    this.audioChunksIn += 1;
    this.socket?.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: bytesToBase64(pcm16_16k), mimeType: 'audio/pcm;rate=16000' },
        },
      }),
    );
  }

  /** Send a text turn. Used for the opening greeting and for scripted nudges. */
  sendText(text: string): void {
    if (!this.isReady() || this.closed) return;
    this.socket?.send(
      JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  /** Decode a base64 audio frame from Gemini into bytes. */
  static decodeAudio(base64: string): Uint8Array {
    return base64ToBytes(base64);
  }

  private fail(error: Error): void {
    this.status = 'ERROR';
    this.closed = true;
    this.options.onError?.(error);
    // Guarded emit: an unhandled 'error' event would throw inside the socket callback and
    // crash the bridge, so only emit when a listener is actually attached.
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  close(reason = 'call ended'): void {
    if (this.closed) return;
    this.closed = true;
    this.status = 'CLOSED';
    // Closing a socket that never finished connecting can emit a spurious ws `error`
    // event ("WebSocket was closed before the connection was established"). That must
    // never crash the process mid-call.
    try {
      if (this.socket) {
        this.socket.removeAllListeners('message');
        // Suppress the close-before-connect error event even though the listener is removed,
        // because the ws module may emit synchronously before the removal takes effect.
        this.socket.on('error', () => { /* suppress */ });
        this.socket.removeAllListeners('close');
        this.socket.close(1000, reason.slice(0, 120));
      }
    } catch {
      /* already gone */
    }
  }

  isClosed(): boolean {
    return this.closed;
  }
}

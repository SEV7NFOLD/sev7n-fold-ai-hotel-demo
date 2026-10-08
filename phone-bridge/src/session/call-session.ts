/**
 * Call session.
 *
 * One instance per phone call. Owns:
 *   - the telephony connection (provider adapter)
 *   - the Gemini Live socket
 *   - the audio conversion between them
 *   - connection state, timestamps and counters
 *   - cleanup handlers
 *
 * The session is the only place that knows both sides exist; the provider adapter and the
 * Gemini client each know nothing about the other.
 *
 * Provider audio contract: the session always deals in μ-law 8 kHz toward the phone and
 * 16 kHz PCM16 toward Gemini, so it is provider-independent.
 */

import { EventEmitter } from 'node:events';
import type { ProviderConnection, ProviderCallMeta } from '../providers/types.js';
import { GeminiLiveSession } from '../gemini/live-session.js';
import { geminiToPhone, phoneToGemini } from '../audio/index.js';
import type { Logger } from '../logging.js';

export type CallState =
  | 'NEW'
  | 'PHONE_CONNECTED'
  | 'GEMINI_CONNECTING'
  | 'ACTIVE'
  | 'ENDING'
  | 'ENDED'
  | 'FAILED';

export interface CallSessionOptions {
  /** Bridge-generated correlation id, unique per call. */
  sessionId: string;
  connection: ProviderConnection;
  logger: Logger;
  gemini: {
    apiKey: string;
    model: string;
    voice: string;
    languageCode: string;
    systemInstruction: string;
  };
  /** Opening line Ava speaks once Gemini is ready; empty string disables it. */
  greeting?: string;
  /** Hard wall-clock limit for the call, seconds. 0 disables. */
  maxCallSeconds: number;
  /** Optional idle nudge: seconds of silence before Ava prompts; 0 disables. */
  idlePromptSeconds: number;
  /** Injectable for tests. */
  geminiFactory?: (options: ConstructorParameters<typeof GeminiLiveSession>[0]) => GeminiLiveSession;
}

export interface CallSessionSnapshot {
  sessionId: string;
  state: CallState;
  provider: string;
  /** Masked by the logger when logging is on. */
  caller: string | undefined;
  startedAt: string;
  geminiReadyAt: string | undefined;
  firstAudioAt: string | undefined;
  endedAt: string | undefined;
  durationMs: number | undefined;
  framesFromCaller: number;
  framesToCaller: number;
  geminiStatus: string;
}

export class CallSession extends EventEmitter {
  readonly sessionId: string;
  readonly meta: ProviderCallMeta;

  private readonly options: CallSessionOptions;
  private readonly logger: Logger;
  private readonly connection: ProviderConnection;
  private gemini: GeminiLiveSession | undefined;

  private state: CallState = 'NEW';
  private readonly startedAt = Date.now();
  private geminiReadyAt: number | undefined;
  private firstAudioAt: number | undefined;
  private endedAt: number | undefined;

  private framesFromCaller = 0;
  private framesToCaller = 0;

  /** True while Ava is speaking; used to decide whether a Gemini interruption needs a provider clear. */
  private avaSpeaking = false;
  private maxCallTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private cleanedUp = false;

  constructor(options: CallSessionOptions) {
    super();
    this.options = options;
    this.sessionId = options.sessionId;
    this.logger = options.logger;
    this.connection = options.connection;
    this.meta = options.connection.meta;
  }

  getState(): CallState {
    return this.state;
  }

  snapshot(): CallSessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.state,
      provider: this.connection.info.name,
      caller: this.meta.from,
      startedAt: new Date(this.startedAt).toISOString(),
      geminiReadyAt: this.geminiReadyAt ? new Date(this.geminiReadyAt).toISOString() : undefined,
      firstAudioAt: this.firstAudioAt ? new Date(this.firstAudioAt).toISOString() : undefined,
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : undefined,
      durationMs: this.endedAt ? this.endedAt - this.startedAt : undefined,
      framesFromCaller: this.framesFromCaller,
      framesToCaller: this.framesToCaller,
      geminiStatus: this.gemini?.getStatus() ?? 'IDLE',
    };
  }

  /** Wire up the telephony side and connect to Gemini. */
  async start(): Promise<void> {
    this.connection.onStart((meta) => {
      this.logger.info('CALL_CONNECTED', {
        sessionId: this.sessionId,
        provider: this.connection.info.name,
        callId: meta.callId,
        from: this.logger.phone(meta.from),
        to: this.logger.phone(meta.to),
        direction: meta.direction,
      });
      this.setState('PHONE_CONNECTED');
      this.emit('phone-connected');
    });

    this.connection.onAudio((payload) => this.handleCallerAudio(payload));

    this.connection.onStop(() => {
      this.logger.info('CALL_ENDED', {
        sessionId: this.sessionId,
        reason: 'provider-stop',
        durationMs: Date.now() - this.startedAt,
      });
      void this.stop('provider-stop');
    });

    this.connection.onError((error) => {
      this.logger.fail('PHONE_ERROR', error, { sessionId: this.sessionId, provider: this.connection.info.name });
      void this.stop('phone-error');
    });

    await this.connectGemini();
  }

  private async connectGemini(): Promise<void> {
    this.setState('GEMINI_CONNECTING');

    const factory =
      this.options.geminiFactory ??
      ((config: ConstructorParameters<typeof GeminiLiveSession>[0]) => new GeminiLiveSession(config));

    const gemini = factory({
      apiKey: this.options.gemini.apiKey,
      model: this.options.gemini.model,
      voice: this.options.gemini.voice,
      languageCode: this.options.gemini.languageCode,
      systemInstruction: this.options.gemini.systemInstruction,
      onAudio: (base64Pcm24k) => this.handleAvaAudio(base64Pcm24k),
      onInterrupted: () => this.handleInterruption(),
      onTurnComplete: () => {
        this.avaSpeaking = false;
      },
      onCallerTranscript: () => this.touchIdleTimer(),
      onError: (error) => {
        this.logger.fail('GEMINI_ERROR', error, { sessionId: this.sessionId });
      },
      onClose: (code, reason) => {
        if (this.state !== 'ENDING' && this.state !== 'ENDED') {
          this.logger.warn('GEMINI_ERROR', {
            sessionId: this.sessionId,
            message: 'Gemini closed the session unexpectedly',
            code,
            closeReason: reason ? reason.slice(0, 120) : undefined,
          });
          void this.stop('gemini-closed');
        }
      },
    });

    this.gemini = gemini;

    try {
      await gemini.connect();
    } catch (error) {
      this.logger.fail('GEMINI_ERROR', error, { sessionId: this.sessionId, phase: 'connect' });
      this.setState('FAILED');
      // Leave the phone connection open long enough for the provider to play its own
      // fallback audio, then close cleanly.
      setTimeout(() => void this.stop('gemini-connect-failed'), 500);
      return;
    }

    this.geminiReadyAt = Date.now();
    this.setState('ACTIVE');
    this.logger.info('GEMINI_CONNECTED', {
      sessionId: this.sessionId,
      model: this.options.gemini.model,
      voice: this.options.gemini.voice,
      setupMs: this.geminiReadyAt - this.startedAt,
    });

    const greeting = this.options.greeting?.trim();
    if (greeting) gemini.sendText(greeting);

    if (this.options.maxCallSeconds > 0) {
      this.maxCallTimer = setTimeout(() => {
        this.logger.warn('CALL_ENDED', { sessionId: this.sessionId, reason: 'max-duration-reached' });
        void this.stop('max-duration-reached');
      }, this.options.maxCallSeconds * 1000);
      this.maxCallTimer.unref?.();
    }

    this.touchIdleTimer();
  }

  /** Caller audio: μ-law 8 kHz -> PCM16 16 kHz -> Gemini. */
  private handleCallerAudio(ulaw8k: Uint8Array): void {
    if (this.state === 'ENDING' || this.state === 'ENDED' || this.state === 'FAILED') return;
    if (!this.gemini?.isReady()) return;

    if (this.firstAudioAt === undefined) {
      this.firstAudioAt = Date.now();
      this.logger.info('AUDIO_STARTED', {
        sessionId: this.sessionId,
        direction: 'caller-to-ava',
        conversionMs: this.firstAudioAt - this.startedAt,
      });
    }

    this.framesFromCaller += 1;
    this.touchIdleTimer();

    try {
      this.gemini.sendAudio(phoneToGemini(ulaw8k));
    } catch (error) {
      this.logger.fail('PHONE_ERROR', error, { sessionId: this.sessionId, phase: 'inbound-audio' });
    }
  }

  /** Ava audio: PCM16 24 kHz -> μ-law 8 kHz -> provider. */
  private handleAvaAudio(base64Pcm24k: string): void {
    if (this.state === 'ENDING' || this.state === 'ENDED' || this.state === 'FAILED') return;
    if (this.connection.isClosed()) return;

    try {
      const pcm24k = GeminiLiveSession.decodeAudio(base64Pcm24k);
      const ulaw8k = geminiToPhone(pcm24k);
      this.avaSpeaking = true;
      this.framesToCaller += 1;
      this.connection.sendAudio(ulaw8k);
    } catch (error) {
      this.logger.fail('PHONE_ERROR', error, { sessionId: this.sessionId, phase: 'outbound-audio' });
    }
  }

  /**
   * Barge-in. Gemini has already stopped generating; we must also tell the provider to drop
   * whatever audio it has buffered, otherwise the caller keeps hearing Ava for up to a
   * buffer-length after they start speaking.
   */
  private handleInterruption(): void {
    const wasSpeaking = this.avaSpeaking;
    this.avaSpeaking = false;
    if (!wasSpeaking) return;

    try {
      this.connection.clear();
    } catch (error) {
      this.logger.fail('PHONE_ERROR', error, { sessionId: this.sessionId, phase: 'barge-in' });
    }
    this.logger.debug('AUDIO_FLOW', { sessionId: this.sessionId, event: 'interrupted', framesToCaller: this.framesToCaller });
  }

  private touchIdleTimer(): void {
    if (this.options.idlePromptSeconds <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.state !== 'ACTIVE') return;
      this.gemini?.sendText('The caller has gone quiet. Briefly check whether they are still there, in one short sentence.');
    }, this.options.idlePromptSeconds * 1000);
    this.idleTimer.unref?.();
  }

  private setState(state: CallState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  /** Tear everything down exactly once. Safe to call from any handler. */
  async stop(reason: string): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.setState('ENDING');

    if (this.maxCallTimer) clearTimeout(this.maxCallTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.maxCallTimer = undefined;
    this.idleTimer = undefined;

    const summary = { ...this.snapshot(), reason };

    try {
      this.gemini?.close(reason);
    } catch (error) {
      this.logger.fail('GEMINI_ERROR', error, { sessionId: this.sessionId, phase: 'close' });
    }

    try {
      this.connection.close(reason);
    } catch (error) {
      this.logger.fail('PHONE_ERROR', error, { sessionId: this.sessionId, phase: 'close' });
    }

    this.endedAt = Date.now();
    this.setState('ENDED');

    this.logger.info('CALL_ENDED', {
      sessionId: this.sessionId,
      reason,
      durationMs: this.endedAt - this.startedAt,
      framesFromCaller: this.framesFromCaller,
      framesToCaller: this.framesToCaller,
    });

    this.logger.info('CALL_CLEANUP', {
      sessionId: this.sessionId,
      geminiClosed: this.gemini?.isClosed() ?? true,
      phoneClosed: this.connection.isClosed(),
      timersCleared: true,
    });

    this.emit('ended', summary);
    this.removeAllListeners();
  }
}

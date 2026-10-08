/**
 * Provider-agnostic telephony contract.
 *
 * The rest of the bridge (session manager, Gemini client, audio pipeline) talks only to
 * these types. Adding a SIP provider or a second CPaaS later means writing one new
 * adapter file — no changes to the session manager.
 *
 * Deliberately *not* a "fake phone simulator": the Twilio adapter speaks the real
 * Media Streams wire protocol over a real WebSocket, and the generic adapter accepts
 * real base64 audio frames from any provider.
 */

export interface ProviderCallMeta {
  /** Provider-side call identifier, e.g. Twilio CallSid or StreamSid. */
  callId: string;
  /** Provider name for logging and metrics. */
  provider: string;
  /** Caller number in E.164 when the provider supplies it. */
  from?: string;
  /** Called number in E.164 when the provider supplies it. */
  to?: string;
  /** Provider-reported direction, e.g. 'inbound' | 'outbound-api'. */
  direction?: string;
  /** Provider-reported call status at the time of connection. */
  status?: string;
  /** Any additional non-sensitive provider fields worth keeping. */
  extra?: Record<string, string>;
}

export interface ProviderInfo {
  /** Stable provider key, e.g. 'twilio'. */
  name: string;
  /** Human-readable description used by GET /. */
  description: string;
  /** Input sample rate of audio arriving from the provider (Hz). */
  inputSampleRate: number;
  /** Output sample rate the provider expects (Hz). */
  outputSampleRate: number;
  /** Encoding used on the wire, for documentation and assertions. */
  encoding: 'mulaw' | 'pcm16';
}

/**
 * A live telephony connection. One instance per call.
 *
 * Lifecycle: `onAudio` / `onStart` / `onStop` fire as the provider sends frames;
 * `sendAudio` pushes Ava's voice back; `clear` implements provider-side barge-in;
 * `close` tears the connection down.
 */
export interface ProviderConnection {
  readonly info: ProviderInfo;
  readonly meta: ProviderCallMeta;

  /** Register handlers. Must be called before audio can arrive. */
  onStart(handler: (meta: ProviderCallMeta) => void): void;
  onAudio(handler: (payload: Uint8Array) => void): void;
  onStop(handler: () => void): void;
  onError(handler: (error: Error) => void): void;

  /** Send μ-law 8 kHz audio to the caller. */
  sendAudio(ulaw8k: Uint8Array): void;
  /** Send an arbitrary text message (used by providers with a control channel). */
  sendMessage(message: Record<string, unknown>): void;
  /**
   * Ask the provider to stop playing queued audio immediately (barge-in).
   * Providers without an outbound buffer may implement this as a no-op.
   */
  clear(): void;
  /** Terminate the call from our side. Idempotent. */
  close(reason: string): void;
  /** True once the connection can no longer carry audio. */
  isClosed(): boolean;
}

/** What a provider must implement to be pluggable. */
export interface PhoneProvider {
  readonly name: string;
  readonly info: ProviderInfo;

  /**
   * Handle the provider's inbound-call HTTP webhook.
   * Returns the body and content type to send back (for Twilio, TwiML).
   * `mediaUrl` is the absolute wss:// URL the provider should stream audio to.
   */
  handleInboundWebhook(request: WebhookRequest, mediaUrl: string): WebhookResponse;

  /**
   * Validate that an inbound webhook is genuinely from the provider.
   * Implementations must return `{ ok: true }` when they cannot check (e.g. no secret
   * configured) but should say so in `reason` so the caller can log a warning.
   */
  validateWebhook(request: WebhookRequest): WebhookValidation;

  /** Attach an already-accepted WebSocket to this provider's media protocol. */
  attachMediaSocket(socket: ProviderSocket, meta: ProviderCallMeta): ProviderConnection;

  /** Provider-specific pre-accept checks, e.g. a shared-secret query parameter. */
  authorizeMediaUpgrade(url: URL, headers: Record<string, string | string[] | undefined>): WebhookValidation;
}

export interface WebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body text exactly as received, required for signature validation. */
  rawBody: string;
  /** Parsed body, form-encoded or JSON. */
  body: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface WebhookValidation {
  ok: boolean;
  /** Populated when ok is false, or when validation was skipped. */
  reason?: string;
  /** True when the check could not be performed because it is not configured. */
  skipped?: boolean;
}

/**
 * Minimal WebSocket surface the adapters depend on.
 *
 * Matches the `ws` package closely enough that a real socket can be passed straight in,
 * while keeping the adapters testable with a stub.
 */
export interface ProviderSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'pong', listener: () => void): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

/** WebSocket readyState values, mirrored so adapters need no dependency on `ws`. */
export const SOCKET_OPEN = 1;

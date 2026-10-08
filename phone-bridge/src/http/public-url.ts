/**
 * Twilio-compatible webhook path rewriting.
 *
 * Twilio signs the *configured* webhook URL, not the URL we see after a reverse proxy
 * has rewritten the host. On Render the service is reachable both as
 * `https://<service>.onrender.com` and behind the platform proxy, so the URL the proxy
 * reports may not match what was configured in the Twilio console.
 *
 * This module makes the signature check deterministic:
 *   PUBLIC_BASE_URL  (or TWILIO_WEBHOOK_URL) is treated as the authoritative URL when set.
 *
 * Without that variable, the request's own origin is used, which is correct for local
 * development (including when tunnelled with ngrok), where the tunnel forwards the
 * original Host header.
 */

export interface PublicUrlOptions {
  /** e.g. https://ava-phone-bridge.onrender.com — no trailing slash. */
  publicBaseUrl?: string | undefined;
  /** Full URL override for the voice webhook, if it differs from publicBaseUrl + path. */
  webhookUrlOverride?: string | undefined;
  trustProxy: boolean;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Compute the canonical public URL for an inbound request.
 * Used for Twilio signature validation and for building the media-stream WSS URL.
 */
export function resolvePublicUrl(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  options: PublicUrlOptions,
): string {
  if (options.webhookUrlOverride) return options.webhookUrlOverride;
  if (options.publicBaseUrl) return `${options.publicBaseUrl}${path}`;

  const host = firstHeaderValue(headers['host']) ?? 'localhost';
  let proto = firstHeaderValue(headers['x-forwarded-proto']) ?? 'http';
  if (!options.trustProxy && !headers['x-forwarded-proto']) proto = 'http';

  return `${proto}://${host}${path}`;
}

/**
 * Derive the absolute wss:// URL the telephony provider should stream audio to.
 * Prefers an explicit PUBLIC_WS_URL or PUBLIC_BASE_URL so that a TLS-terminating proxy
 * never produces a `ws://` URL that the provider will reject.
 */
export function resolveMediaSocketUrl(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  options: PublicUrlOptions & { publicWsUrl?: string | undefined; query?: Record<string, string> | undefined },
): string {
  const query = options.query ?? {};
  const search = new URLSearchParams(query).toString();

  const base =
    options.publicWsUrl ??
    (options.publicBaseUrl ? options.publicBaseUrl.replace(/^http/, 'ws') : undefined) ??
    resolvePublicUrl(path, headers, options).replace(/^http/, 'ws');

  return `${base.replace(/^https/, 'wss')}${path}${search ? `?${search}` : ''}`;
}

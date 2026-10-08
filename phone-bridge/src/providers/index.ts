/**
 * Provider registry.
 *
 * The bridge resolves a provider by name. Adding a provider means adding one file here
 * and one line in `createProvider` — the session manager and server never change.
 */

import type { PhoneProvider } from './types.js';
import { TwilioProvider } from './twilio.js';
import { GenericProvider } from './generic.js';

export type ProviderName = 'twilio' | 'generic';

export interface ProviderFactoryOptions {
  twilioAuthToken?: string | undefined;
  mediaToken?: string | undefined;
  maxCallSeconds?: number;
}

export function createProvider(name: ProviderName, options: ProviderFactoryOptions = {}): PhoneProvider {
  switch (name) {
    case 'twilio':
      return new TwilioProvider({
        authToken: options.twilioAuthToken,
        maxCallSeconds: options.maxCallSeconds,
      });
    case 'generic':
      return new GenericProvider({ mediaToken: options.mediaToken });
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}

/** Providers the bridge can serve, keyed by the path segment that routes to them. */
export const SUPPORTED_PROVIDERS: ProviderName[] = ['twilio', 'generic'];

export function isProviderName(value: string): value is ProviderName {
  return (SUPPORTED_PROVIDERS as string[]).includes(value);
}

export { TwilioProvider, GenericProvider };
export * from './types.js';

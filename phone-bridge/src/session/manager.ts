/**
 * Call session manager.
 *
 * Owns every live CallSession: creates them, enforces the concurrency ceiling, and
 * guarantees cleanup even if a session ends abnormally. Also exposes the active-session
 * table for diagnostics — with caller numbers masked.
 */

import { randomUUID } from 'node:crypto';
import { CallSession, type CallSessionSnapshot } from './call-session.js';
import type { ProviderConnection } from '../providers/types.js';
import type { Logger } from '../logging.js';

export interface SessionManagerOptions {
  logger: Logger;
  maxConcurrentCalls: number;
  gemini: {
    apiKey: string;
    model: string;
    voice: string;
    languageCode: string;
    systemInstruction: string;
  };
  greeting?: string;
  maxCallSeconds: number;
  idlePromptSeconds: number;
}

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`Concurrent call limit reached (${limit})`);
    this.name = 'SessionLimitError';
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, CallSession>();
  private readonly options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  /** Create the correlation id for a new call before we know the provider's call id. */
  newSessionId(): string {
    return `ava-${randomUUID()}`;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  list(): CallSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  /**
   * Register and start a session for an accepted media socket.
   * Throws SessionLimitError when the bridge is at capacity, so the caller can close the
   * socket with a clear reason instead of silently dropping audio.
   */
  async createAndStart(sessionId: string, connection: ProviderConnection): Promise<CallSession> {
    if (this.sessions.size >= this.options.maxConcurrentCalls) {
      throw new SessionLimitError(this.options.maxConcurrentCalls);
    }

    const session = new CallSession({
      sessionId,
      connection,
      logger: this.options.logger,
      gemini: this.options.gemini,
      greeting: this.options.greeting,
      maxCallSeconds: this.options.maxCallSeconds,
      idlePromptSeconds: this.options.idlePromptSeconds,
    });

    this.sessions.set(sessionId, session);
    session.once('ended', () => {
      this.sessions.delete(sessionId);
    });

    try {
      await session.start();
    } catch (error) {
      // start() is written to be total, but never leak a session if it is not.
      this.sessions.delete(sessionId);
      await session.stop('start-failed');
      throw error;
    }

    return session;
  }

  /** Stop one session by id. */
  async stop(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.stop(reason);
    this.sessions.delete(sessionId);
  }

  /** Stop everything. Used on SIGTERM so Render deploys do not drop calls mid-sentence. */
  async shutdown(reason = 'service-shutdown'): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id, reason)));
    this.sessions.clear();
  }
}

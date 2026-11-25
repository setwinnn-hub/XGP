import { fetchSecurity, type SecurityReport } from '../analysis/security.ts';
import type { ChainId } from '../core/types.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import { fetchHoneypot, type HoneypotResult } from './honeypot.ts';

/** Contract facts change rarely; taxes can, so re-check every half hour. */
const TTL_MS = 30 * 60_000;
const RATE_LIMIT_PAUSE_MS = 2 * 60_000;

export interface SecuritySources {
  readonly goplus: SecurityReport | null;
  readonly honeypot: HoneypotResult | null;
  /** When the sources were last fetched (null = never succeeded). */
  readonly at: number | null;
}

export interface SecurityCacheDeps {
  readonly logger: Logger;
  readonly fetchSecurity?: typeof fetchSecurity;
  readonly fetchHoneypot?: typeof fetchHoneypot;
  readonly now?: () => number;
}

export interface SecurityCache {
  /** Cached sources; refreshes when stale and `allowFetch` is true (caller limits fetches per pass). */
  get(chain: ChainId, token: string, allowFetch: boolean): Promise<SecuritySources & { fetched: boolean }>;
}

/**
 * GoPlus + honeypot.is per token with a TTL. A failed source keeps its previous answer (or
 * stays null = UNKNOWN); a rate-limit answer pauses that source for a while.
 */
export function createSecurityCache(deps: SecurityCacheDeps): SecurityCache {
  const logger = deps.logger.child({ source: 'gem:security' });
  const now = deps.now ?? Date.now;
  let cache = new Map<string, SecuritySources>();
  const pausedUntil = { goplus: 0, honeypot: 0 };

  const guarded = async <T>(name: keyof typeof pausedUntil, run: () => Promise<T>, previous: T): Promise<T> => {
    if (now() < pausedUntil[name]) return previous;
    try {
      return await run();
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (/429|rate|limit/i.test(message)) pausedUntil[name] = now() + RATE_LIMIT_PAUSE_MS;
      logger.debug(`${name} lookup failed`, { error: message });
      return previous;
    }
  };

  return {
    async get(chain, token, allowFetch) {
      const key = `${chain}:${chain === 'solana' ? token : token.toLowerCase()}`;
      const cached = cache.get(key) ?? { goplus: null, honeypot: null, at: null };
      const stale = cached.at === null || now() - cached.at >= TTL_MS;
      if (!stale || !allowFetch) return { ...cached, fetched: false };
      const goplus = await guarded('goplus', () => (deps.fetchSecurity ?? fetchSecurity)(chain, token), cached.goplus);
      const honeypot = await guarded('honeypot', () => (deps.fetchHoneypot ?? fetchHoneypot)(chain, token), cached.honeypot);
      const fresh: SecuritySources = { goplus, honeypot, at: now() };
      cache = new Map([...cache].filter(([, v]) => v.at !== null && now() - v.at < 4 * TTL_MS)).set(key, fresh);
      return { ...fresh, fetched: true };
    },
  };
}

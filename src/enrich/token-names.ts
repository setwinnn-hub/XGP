import { errorMessage, type Logger } from '../core/logger.ts';
import type { ChainId } from '../core/types.ts';
import type { EventRepository } from '../storage/event-repo.ts';
import { fetchDexScreenerTokenName, type TokenName } from './dexscreener.ts';

const CACHE_LIMIT = 5_000;
const NEGATIVE_TTL_MS = 60_000;

export type NameLookup = (chain: ChainId, token: string) => Promise<TokenName | null>;

/**
 * Token name lookup: in-memory cache, then names stored from launch events, then
 * DexScreener. Unknown tokens are retried after a minute (they may get indexed).
 */
export function createNameLookup(repo: EventRepository, logger: Logger, fetchFn: typeof fetch = fetch): NameLookup {
  const cache = new Map<string, { value: TokenName | null; at: number }>();

  const remember = (key: string, value: TokenName | null): TokenName | null => {
    cache.set(key, { value, at: Date.now() });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? key);
    return value;
  };

  return async (chain, token) => {
    const key = `${chain}:${token}`;
    const hit = cache.get(key);
    if (hit && (hit.value || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.value;
    const stored = repo.findTokenName(chain, token);
    if (stored) return remember(key, stored);
    try {
      return remember(key, await fetchDexScreenerTokenName(chain, token, fetchFn));
    } catch (error: unknown) {
      logger.debug('token name lookup failed', { chain, token, error: errorMessage(error) });
      return remember(key, null);
    }
  };
}

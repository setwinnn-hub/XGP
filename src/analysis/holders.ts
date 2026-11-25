import type { ChainId } from '../core/types.ts';
import { sleep } from '../core/util.ts';
import { GECKOTERMINAL_NETWORK } from '../news/geckoterminal-trending.ts';

/** Holder base of a token from GeckoTerminal (any chain, free, no key). */
export interface Holders {
  readonly count: number;
  /** Share of supply held by the 10 largest addresses (0–100); may include pools and exchanges. */
  readonly top10Pct: number | null;
}

const API = 'https://api.geckoterminal.com/api/v2/networks';
const TTL_MS = 30 * 60_000;
/** GeckoTerminal answers 429 to bursts: keep lookups apart (trending polls share the same limit). */
const GAP_MS = 3_000;
const TIMEOUT_MS = 10_000;

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === 'object' ? (value as Raw) : {};
}

/** Parses /networks/{net}/tokens/{addr}/info. null when there is no holder data. */
export function parseHolders(body: unknown): Holders | null {
  const holders = obj(obj(obj(body).data).attributes).holders;
  if (!holders || typeof holders !== 'object') return null;
  const count = Number(obj(holders).count);
  if (!Number.isFinite(count) || count < 0) return null;
  const top10 = Number(obj(obj(holders).distribution_percentage).top_10);
  return { count, top10Pct: Number.isFinite(top10) && top10 >= 0 && top10 <= 100 ? top10 : null };
}

export interface HolderLookupDeps {
  readonly fetchFn?: typeof fetch;
  readonly gapMs?: number;
  readonly now?: () => number;
}

export type HolderLookup = (chain: ChainId, token: string) => Promise<Holders | null>;

/** Cached, rate-spaced holder lookups. Failures return null (never throw) and are not cached. */
export function createHolderLookup(deps: HolderLookupDeps = {}): HolderLookup {
  const now = deps.now ?? Date.now;
  let cache = new Map<string, { at: number; value: Holders | null }>();
  let nextAllowedAt = 0;
  let chainTail: Promise<unknown> = Promise.resolve();

  const fetchOne = async (network: string, token: string): Promise<Holders | null> => {
    const wait = nextAllowedAt - now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = now() + (deps.gapMs ?? GAP_MS);
    const response = await (deps.fetchFn ?? fetch)(`${API}/${network}/tokens/${encodeURIComponent(token)}/info`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
    return parseHolders(await response.json());
  };

  return async (chain, token) => {
    const network = GECKOTERMINAL_NETWORK[chain];
    if (!network) return null;
    const id = chain === 'solana' ? token : token.toLowerCase();
    const key = `${chain}:${id}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    // One request at a time, in call order, so the spacing holds under concurrent analyses.
    const run = chainTail.then(() => fetchOne(network, id));
    chainTail = run.catch(() => undefined);
    try {
      const value = await run;
      cache = new Map([...cache].filter(([, v]) => now() - v.at < TTL_MS)).set(key, { at: now(), value });
      return value;
    } catch {
      return null;
    }
  };
}

import type { TokenRef } from '../analysis/analysis-engine.ts';
import type { MarketSnapshot } from '../analysis/market.ts';
import type { WatchEntry } from './swap-store.ts';

/** A brand-new pair is watched this long; analysis or the watchlist extend it. */
export const NEW_PAIR_TTL_MS = 90 * 60_000;
/** Tokens on the Early Gem watchlist stay collected for a day after their last promotion. */
export const WATCHLIST_TTL_MS = 24 * 60 * 60_000;

/** How long a token's swaps are collected after its latest analysis. */
export const WATCH_TTL_MS = 6 * 60 * 60_000;

/**
 * Tokens already worth more than this are not early gems (e.g. WBTC or DAI bought by a followed
 * wallet). Well above the default ฿500k ceiling so tokens that run past the range stay tracked.
 */
export const MAX_WATCH_MCAP_USD = 1_000_000;

const EVM_POOL = /^0x[0-9a-fA-F]{40}$/;
const V4_POOL_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * Which analysed tokens get their buys/sells collected: EVM tokens whose DexScreener pair is a
 * pool contract (V2/V3) or a Uniswap V4 pool id. Solana is not collected yet (needs a paid RPC).
 */
export function watchFor(ref: TokenRef, market: Pick<MarketSnapshot, 'pairAddress' | 'marketCapUsd' | 'fdvUsd'> | null, now: number): WatchEntry | null {
  const pool = market?.pairAddress ?? null;
  if (ref.chain === 'solana' || ref.chain === 'offchain' || !pool) return null;
  // Unknown value (no price yet) is watched: that is exactly the earliest stage.
  const value = market?.marketCapUsd ?? market?.fdvUsd ?? null;
  if (value !== null && value > MAX_WATCH_MCAP_USD) return null;
  const poolKind = EVM_POOL.test(pool) ? 'pair' : V4_POOL_ID.test(pool) ? 'v4' : null;
  if (!poolKind) return null;
  return {
    chain: ref.chain, token: ref.token, pool: pool.toLowerCase(), poolKind,
    symbol: ref.symbol, reason: 'analysed', addedAt: now, expiresAt: now + WATCH_TTL_MS,
  };
}

/**
 * Watch a pair from its creation event, before DexScreener lists it: the event already has the
 * on-chain pool (V2/V3 pair address or V4 pool id). Market cap is unknown this early, so the
 * $1M cap is applied later by the scoring (REJECTED above range).
 */
export function watchForNewPair(ref: TokenRef, pairId: unknown, now: number): WatchEntry | null {
  if (typeof pairId !== 'string') return null;
  const entry = watchFor(ref, { pairAddress: pairId, marketCapUsd: null, fdvUsd: null }, now);
  return entry ? { ...entry, reason: 'new-pair', expiresAt: now + NEW_PAIR_TTL_MS } : null;
}

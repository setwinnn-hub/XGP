import type { SwapRow } from './swap-store.ts';

export const WINDOWS_MIN = [1, 5, 15, 60] as const;

export interface WindowStats {
  readonly minutes: number;
  /** False when collection started (or had a gap) after this window began: counts are partial. */
  readonly complete: boolean;
  readonly buys: number;
  readonly sells: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  /** Wallets whose first recorded buy of this token is inside the window. */
  readonly newBuyers: number;
  /** Wallets that bought inside the window and had bought before it. */
  readonly returningBuyers: number;
  /** Wallets with two or more buys inside the window. */
  readonly multiBuyWallets: number;
  readonly buyTokens: number;
  readonly sellTokens: number;
  /** Buy transactions per sell transaction; null when there were no sells. */
  readonly buySellRatio: number | null;
  readonly previousUniqueBuyers: number;
  /** Change vs the window right before; null when the previous window had no buyers or is not covered. */
  readonly uniqueBuyersGrowthPct: number | null;
}

function windowStats(swaps: readonly SwapRow[], firstBuy: ReadonlyMap<string, number>, now: number, minutes: number, coverageSince: number): WindowStats {
  const length = minutes * 60_000;
  const start = now - length;
  const prevStart = start - length;
  const inWindow = swaps.filter((s) => s.blockTime > start && s.blockTime <= now);
  const buys = inWindow.filter((s) => s.side === 'BUY');
  const sells = inWindow.filter((s) => s.side === 'SELL');
  const buyCount = new Map<string, number>();
  for (const b of buys) buyCount.set(b.wallet, (buyCount.get(b.wallet) ?? 0) + 1);
  const buyers = [...buyCount.keys()];
  const previousBuyers = new Set(swaps.filter((s) => s.side === 'BUY' && s.blockTime > prevStart && s.blockTime <= start).map((s) => s.wallet));
  const previousCovered = coverageSince <= prevStart;
  return {
    minutes,
    complete: coverageSince <= start,
    buys: buys.length,
    sells: sells.length,
    uniqueBuyers: buyers.length,
    uniqueSellers: new Set(sells.map((s) => s.wallet)).size,
    newBuyers: buyers.filter((w) => (firstBuy.get(w) ?? 0) > start).length,
    returningBuyers: buyers.filter((w) => (firstBuy.get(w) ?? Infinity) <= start).length,
    multiBuyWallets: [...buyCount.values()].filter((n) => n >= 2).length,
    buyTokens: buys.reduce((sum, b) => sum + b.tokenAmount, 0),
    sellTokens: sells.reduce((sum, s) => sum + s.tokenAmount, 0),
    buySellRatio: sells.length > 0 ? buys.length / sells.length : null,
    previousUniqueBuyers: previousBuyers.size,
    uniqueBuyersGrowthPct: previousCovered && previousBuyers.size > 0 ? ((buyers.length - previousBuyers.size) / previousBuyers.size) * 100 : null,
  };
}

/**
 * Buyer statistics per time window from recorded swaps. Each wallet counts once per window
 * no matter how many times it bought. Pure: same input, same output.
 */
export function buyerWindows(swaps: readonly SwapRow[], now: number, coverageSince: number): readonly WindowStats[] {
  const firstBuy = new Map<string, number>();
  for (const s of swaps) {
    if (s.side === 'BUY' && !firstBuy.has(s.wallet)) firstBuy.set(s.wallet, s.blockTime);
  }
  return WINDOWS_MIN.map((m) => windowStats(swaps, firstBuy, now, m, coverageSince));
}

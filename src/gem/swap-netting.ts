/** A token Transfer touching a watched pool, as read from logs. */
export interface PoolTransfer {
  readonly token: string;
  readonly txHash: string;
  readonly block: number;
  /** Raw token units moved out of (+) or into (−) the pool. */
  readonly outOfPool: bigint;
}

export interface NetSwap {
  readonly token: string;
  readonly txHash: string;
  readonly block: number;
  readonly side: 'BUY' | 'SELL';
  /** Raw token units (absolute value of the net movement). */
  readonly raw: bigint;
}

/** Below this share of gross flow, a tx that both takes from and gives to the pool is arbitrage. */
const ARBITRAGE_NET_SHARE = 10n;

/**
 * Nets every transaction's flow per token. Liquidity adds/removes are excluded by requiring a
 * Swap event in the same tx; arbitrage/sandwich legs that cancel out (net < 10% of gross) are dropped.
 */
export function netSwaps(transfers: readonly PoolTransfer[], swapTxs: ReadonlySet<string>): NetSwap[] {
  const flows = new Map<string, { token: string; txHash: string; block: number; net: bigint; gross: bigint }>();
  for (const t of transfers) {
    if (!swapTxs.has(t.txHash)) continue;
    const key = `${t.txHash}:${t.token}`;
    const prev = flows.get(key) ?? { token: t.token, txHash: t.txHash, block: t.block, net: 0n, gross: 0n };
    const abs = t.outOfPool < 0n ? -t.outOfPool : t.outOfPool;
    flows.set(key, { ...prev, net: prev.net + t.outOfPool, gross: prev.gross + abs });
  }
  return [...flows.values()].flatMap((f) => {
    const abs = f.net < 0n ? -f.net : f.net;
    if (abs === 0n || abs * ARBITRAGE_NET_SHARE < f.gross) return [];
    return [{ token: f.token, txHash: f.txHash, block: f.block, side: f.net > 0n ? 'BUY' as const : 'SELL' as const, raw: abs }];
  });
}

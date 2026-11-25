export type TradeSide = 'BUY' | 'SELL';

/** Net change of one quote asset (SOL/ETH/BNB incl. wrapped, or a stablecoin) for the wallet. */
export interface QuoteDelta {
  readonly symbol: string;
  readonly amount: number;
  readonly stable: boolean;
}

/** Net change of one non-quote token for the wallet (positive = received). */
export interface TokenDelta {
  readonly token: string;
  readonly amount: number;
}

export interface ClassifiedTrade {
  readonly side: TradeSide;
  readonly token: string;
  readonly tokenAmount: number;
  readonly quoteSymbol: string;
  readonly quoteAmount: number;
  readonly quoteIsStable: boolean;
}

export type ClassifyResult =
  | { readonly ok: true; readonly trade: ClassifiedTrade }
  | { readonly ok: false; readonly reason: string };

/**
 * DEX-agnostic swap detection from the wallet's balance changes in one transaction:
 * exactly one token moved, and a quote asset moved the opposite way.
 * Works for any router/aggregator because it never decodes DEX instructions.
 */
export function classifySwap(quotes: readonly QuoteDelta[], tokens: readonly TokenDelta[]): ClassifyResult {
  const moved = tokens.filter((t) => t.amount !== 0);
  if (moved.length === 0) return { ok: false, reason: 'no token balance change' };
  if (moved.length > 1) return { ok: false, reason: `token-to-token or multi-token tx (${moved.length} tokens)` };
  const token = moved[0];
  if (!token) return { ok: false, reason: 'no token' };

  const opposite = quotes.filter((q) => q.amount !== 0 && Math.sign(q.amount) === -Math.sign(token.amount));
  if (opposite.length === 0) return { ok: false, reason: 'token moved without a matching quote payment (transfer/airdrop)' };
  // A stablecoin leg is the trade's price; a native leg next to it is usually just fees.
  const quote = opposite.find((q) => q.stable) ?? opposite.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));

  return {
    ok: true,
    trade: {
      side: token.amount > 0 ? 'BUY' : 'SELL',
      token: token.token,
      tokenAmount: Math.abs(token.amount),
      quoteSymbol: quote.symbol,
      quoteAmount: Math.abs(quote.amount),
      quoteIsStable: quote.stable,
    },
  };
}

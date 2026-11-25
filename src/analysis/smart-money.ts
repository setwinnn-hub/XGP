export interface TradeRecord {
  readonly wallet: string;
  readonly label: string | null;
  readonly chain: string;
  readonly token: string;
  readonly symbol: string | null;
  readonly side: 'BUY' | 'SELL';
  readonly tokenAmount: number;
  /** null when no USD price was known at the time; such trades are not used for P/L. */
  readonly usdValue: number | null;
  readonly at: number;
}

export interface WalletStats {
  readonly wallet: string;
  readonly label: string | null;
  readonly chain: string;
  readonly trades: number;
  readonly buys: number;
  readonly sells: number;
  readonly tokens: number;
  /** Positions bought while tracked and sold (almost) completely, with a priced result. */
  readonly closedPositions: number;
  readonly wins: number;
  readonly winRatePct: number | null;
  readonly realizedPnlUsd: number;
  /** USD put into the closed positions; small totals are not ranked. */
  readonly closedStakeUsd: number;
  readonly avgHoldMinutes: number | null;
  /** Closed positions sold at >= 2x the wallet's average buy price. */
  readonly doubledEntries: number;
  readonly unpricedTrades: number;
  /** 0–100, null when there is not enough history to rank fairly. */
  readonly rankScore: number | null;
}

interface Lot {
  readonly amount: number;
  /** null = bought without a known USD price; excluded from P/L. */
  readonly costUsd: number | null;
  readonly at: number;
}

interface TokenBook {
  readonly lots: readonly Lot[];
  readonly boughtAmount: number;
  readonly realizedUsd: number;
  readonly pricedSell: boolean;
  readonly holdWeighted: number;
  readonly heldAmount: number;
  readonly buyUsd: number;
  readonly pricedBuyAmount: number;
  readonly costOfSold: number;
  readonly bestSellPrice: number;
}

/** Minimum closed positions before a wallet gets a rank (one lucky trade is not a track record). */
export const MIN_CLOSED_FOR_RANK = 3;
/** Minimum USD put into closed positions before a wallet gets a rank (dust wins are not skill). */
export const MIN_STAKE_FOR_RANK_USD = 50;
/** A position counts as closed when at most this share of what was bought is still held. */
const CLOSED_REMAINDER = 0.01;

const EMPTY_BOOK: TokenBook = {
  lots: [], boughtAmount: 0, realizedUsd: 0, pricedSell: false, holdWeighted: 0, heldAmount: 0,
  buyUsd: 0, pricedBuyAmount: 0, costOfSold: 0, bestSellPrice: 0,
};

interface Consumed {
  readonly lots: Lot[];
  readonly pricedAmount: number;
  readonly pricedCost: number;
  readonly holdWeighted: number;
}

/** Takes `amount` tokens from the oldest lots first (FIFO). */
function consume(lots: readonly Lot[], amount: number, at: number): Consumed {
  let remaining = amount;
  let pricedAmount = 0;
  let pricedCost = 0;
  let holdWeighted = 0;
  const left: Lot[] = [];
  for (const lot of lots) {
    if (remaining <= 0) { left.push(lot); continue; }
    const take = Math.min(lot.amount, remaining);
    const share = take / lot.amount;
    remaining -= take;
    holdWeighted += take * (at - lot.at);
    if (lot.costUsd !== null) {
      pricedAmount += take;
      pricedCost += lot.costUsd * share;
    }
    if (take < lot.amount) left.push({ amount: lot.amount - take, costUsd: lot.costUsd === null ? null : lot.costUsd * (1 - share), at: lot.at });
  }
  return { lots: left, pricedAmount, pricedCost, holdWeighted };
}

function applySell(book: TokenBook, sell: TradeRecord): TokenBook {
  const used = consume(book.lots, sell.tokenAmount, sell.at);
  // Tokens bought before tracking or without a price never count toward P/L.
  if (used.pricedAmount === 0 || sell.usdValue === null || sell.tokenAmount <= 0) return { ...book, lots: used.lots };
  const proceeds = sell.usdValue * (used.pricedAmount / sell.tokenAmount);
  return {
    ...book,
    lots: used.lots,
    realizedUsd: book.realizedUsd + proceeds - used.pricedCost,
    pricedSell: true,
    holdWeighted: book.holdWeighted + used.holdWeighted,
    heldAmount: book.heldAmount + used.pricedAmount,
    costOfSold: book.costOfSold + used.pricedCost,
    bestSellPrice: Math.max(book.bestSellPrice, sell.usdValue / sell.tokenAmount),
  };
}

function applyBuy(book: TokenBook, buy: TradeRecord): TokenBook {
  if (buy.tokenAmount <= 0) return book;
  return {
    ...book,
    lots: [...book.lots, { amount: buy.tokenAmount, costUsd: buy.usdValue, at: buy.at }],
    boughtAmount: book.boughtAmount + buy.tokenAmount,
    buyUsd: book.buyUsd + (buy.usdValue ?? 0),
    pricedBuyAmount: book.pricedBuyAmount + (buy.usdValue === null ? 0 : buy.tokenAmount),
  };
}

function isClosed(book: TokenBook): boolean {
  const remaining = book.lots.reduce((sum, lot) => sum + lot.amount, 0);
  return book.pricedSell && book.boughtAmount > 0 && remaining <= book.boughtAmount * CLOSED_REMAINDER;
}

/**
 * Track-record score: win rate dominates, realized profit adds on a log scale (so one huge
 * win cannot carry a wallet), and more closed positions add confidence.
 */
export function rankScore(winRatePct: number, realizedPnlUsd: number, closed: number): number {
  const winPart = winRatePct * 0.5;
  const pnlPart = realizedPnlUsd > 0 ? Math.min(30, Math.log10(1 + realizedPnlUsd) * 7.5) : Math.max(-20, -Math.log10(1 - realizedPnlUsd) * 7.5);
  const depthPart = Math.min(20, closed * 2);
  return Math.round(Math.max(0, Math.min(100, winPart + pnlPart + depthPart)));
}

function statsFor(trades: readonly TradeRecord[]): WalletStats {
  const sorted = [...trades].sort((a, b) => a.at - b.at);
  const books = new Map<string, TokenBook>();
  for (const t of sorted) {
    const book = books.get(t.token) ?? EMPTY_BOOK;
    books.set(t.token, t.side === 'BUY' ? applyBuy(book, t) : applySell(book, t));
  }
  const closed = [...books.values()].filter(isClosed);
  const wins = closed.filter((b) => b.realizedUsd > 0).length;
  const held = closed.reduce((sum, b) => sum + b.heldAmount, 0);
  const realized = closed.reduce((sum, b) => sum + b.realizedUsd, 0);
  const stake = closed.reduce((sum, b) => sum + b.costOfSold, 0);
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null;
  const first = sorted[0];
  const rankable = winRate !== null && closed.length >= MIN_CLOSED_FOR_RANK && stake >= MIN_STAKE_FOR_RANK_USD;
  return {
    wallet: first?.wallet ?? '',
    label: first?.label ?? null,
    chain: first?.chain ?? '',
    trades: sorted.length,
    buys: sorted.filter((t) => t.side === 'BUY').length,
    sells: sorted.filter((t) => t.side === 'SELL').length,
    tokens: books.size,
    closedPositions: closed.length,
    wins,
    winRatePct: winRate,
    realizedPnlUsd: realized,
    closedStakeUsd: stake,
    avgHoldMinutes: held > 0 ? closed.reduce((sum, b) => sum + b.holdWeighted, 0) / held / 60_000 : null,
    doubledEntries: closed.filter((b) => b.pricedBuyAmount > 0 && b.bestSellPrice >= 2 * (b.buyUsd / b.pricedBuyAmount)).length,
    unpricedTrades: sorted.filter((t) => t.usdValue === null).length,
    rankScore: rankable && winRate !== null ? rankScore(winRate, realized, closed.length) : null,
  };
}

/** Per-wallet statistics, ranked (wallets without enough history last). */
export function rankWallets(trades: readonly TradeRecord[]): WalletStats[] {
  const byWallet = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const key = `${t.chain}:${t.wallet}`;
    byWallet.set(key, [...(byWallet.get(key) ?? []), t]);
  }
  return [...byWallet.values()].map(statsFor).sort((a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1) || b.realizedPnlUsd - a.realizedPnlUsd);
}

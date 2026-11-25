import { exitLiquidityUsd, type MarketSnapshot } from '../analysis/market.ts';
import type { PairReserves } from './pool-reserves.ts';
import type { GemSettings } from './settings.ts';
import { estimateSlippage } from './slippage.ts';

/** Three separate questions, never merged into one label (spec Phase 5). */
export type ActivityStatus = 'NO_REAL_ACTIVITY' | 'LOW_ACTIVITY' | 'ACTIVE';
export type LiquidityStatus = 'INSUFFICIENT_LIQUIDITY' | 'OK' | 'UNKNOWN';
export type SlippageMethod = 'V2_RESERVES' | 'CONSTANT_PRODUCT_ESTIMATE' | 'NONE';
export type LiquidityFlag = 'LIQUIDITY_DROP' | 'LIQUIDITY_GROWING' | 'RESERVES_MISMATCH' | 'ONE_SIDED';

export interface ActivityInput {
  /** From our own swap records (null when the 60-minute window is not fully covered). */
  readonly buys60m: number | null;
  readonly uniqueBuyers60m: number | null;
  readonly independentBuyers15m: number | null;
  /** 15-minute window from our records (null when not covered): used while the hour is still filling. */
  readonly buys15m?: number | null;
  readonly uniqueBuyers15m?: number | null;
  /** DexScreener's 1-hour transaction count, used when our records do not cover the hour. */
  readonly dexTxnsH1: number | null;
}

export interface LiquiditySnapshot {
  readonly at: number;
  readonly liquidityUsd: number;
}

export interface LiquidityInput {
  readonly market: MarketSnapshot | null;
  readonly reserves: PairReserves | null;
  /** Pool fee as a fraction (GoPlus dex list); V2 default 0.3% when unknown. */
  readonly poolFee: number | null;
  readonly thbPerUsd: number | null;
  readonly settings: GemSettings;
  readonly activity: ActivityInput;
  /** Earlier snapshots of this pool's liquidity, any order. */
  readonly history: readonly LiquiditySnapshot[];
  readonly now: number;
}

export interface LiquidityReport {
  readonly activity: ActivityStatus;
  readonly liquidity: LiquidityStatus;
  readonly liquidityUsd: number | null;
  readonly liquidityThb: number | null;
  readonly liquiditySource: 'onchain-reserves' | 'dexscreener' | 'none';
  /**
   * What a seller can actually get out: twice the quote-token side (ETH/BNB/USD). Equals the
   * pool value for a balanced V2 pair; far lower for one-sided concentrated positions.
   */
  readonly exitLiquidityUsd: number | null;
  readonly exitLiquidityThb: number | null;
  readonly buySlippagePct: number | null;
  readonly sellSlippagePct: number | null;
  readonly slippageMethod: SlippageMethod;
  readonly testTradeThb: number;
  readonly poolAgeMin: number | null;
  /** Change versus the highest value in the last 60 minutes (negative = liquidity left). */
  readonly changeFromPeak60mPct: number | null;
  readonly flags: readonly LiquidityFlag[];
  readonly reasons: readonly string[];
}

const DEFAULT_V2_FEE = 0.003;
const DROP_ALERT_PCT = -30;
const GROWING_PCT = 20;
const RESERVES_TOLERANCE = 0.05;
/** Quote side below this share of the pool value = one-sided (e.g. token-only V4 launch position). */
const ONE_SIDED_SHARE = 0.1;
const HOUR = 60 * 60_000;

function activityOf(a: ActivityInput, s: GemSettings): { status: ActivityStatus; reason: string } {
  if (a.buys60m !== null) {
    if (a.buys60m === 0) return { status: 'NO_REAL_ACTIVITY', reason: 'ไม่มีการซื้อจริงใน 60 นาที (จากข้อมูล on-chain ที่เก็บเอง)' };
    const low = a.buys60m < s.minBuyTransactions || (a.uniqueBuyers60m ?? 0) < s.minUniqueBuyers || (a.independentBuyers15m ?? 0) < s.minIndependentWallets;
    return low
      ? { status: 'LOW_ACTIVITY', reason: `มีการซื้อจริง ${a.buys60m} ครั้ง / ${a.uniqueBuyers60m ?? 0} กระเป๋าใน 60 นาที (ยังน้อยกว่าเกณฑ์)` }
      : { status: 'ACTIVE', reason: `ซื้อ ${a.buys60m} ครั้ง / ${a.uniqueBuyers60m ?? 0} กระเป๋าใน 60 นาที` };
  }
  const b15 = a.buys15m ?? null;
  const u15 = a.uniqueBuyers15m ?? null;
  if (b15 !== null && u15 !== null && b15 >= s.minBuyTransactions && u15 >= s.minUniqueBuyers && (a.independentBuyers15m ?? 0) >= s.minIndependentWallets) {
    return { status: 'ACTIVE', reason: `ซื้อ ${b15} ครั้ง / ${u15} กระเป๋าใน 15 นาที (ข้อมูลยังไม่ครบชั่วโมง แต่ 15 นาทีผ่านเกณฑ์แล้ว)` };
  }
  if (a.dexTxnsH1 === null || a.dexTxnsH1 === 0) return { status: 'NO_REAL_ACTIVITY', reason: 'ไม่มีธุรกรรมใน 1 ชม. (DexScreener)' };
  return { status: 'LOW_ACTIVITY', reason: `DexScreener เห็น ${a.dexTxnsH1} ธุรกรรมใน 1 ชม. แต่เรายังเก็บข้อมูลเองไม่ครบชั่วโมง` };
}

interface PoolValue {
  readonly usd: number | null;
  readonly exitUsd: number | null;
  readonly source: LiquidityReport['liquiditySource'];
  readonly quoteUsd: number | null;
}

/** Pool size in USD: on-chain V2 reserves priced through the token's own USD price, else DexScreener. */
function poolValue(market: MarketSnapshot | null, reserves: PairReserves | null): PoolValue {
  const price = market?.priceUsd ?? null;
  if (reserves && price !== null && reserves.quoteReserve > 0) {
    // Quote token USD price from this pool's own mid price (token price is arbitraged across pools).
    const quoteUsd = price * (reserves.tokenReserve / reserves.quoteReserve);
    const usd = reserves.quoteReserve * quoteUsd * 2;
    return { usd, exitUsd: usd, source: 'onchain-reserves', quoteUsd };
  }
  if (market?.liquidityUsd === null || market?.liquidityUsd === undefined) return { usd: null, exitUsd: null, source: 'none', quoteUsd: null };
  const quoteUsd = market.priceUsd && market.priceNative ? market.priceUsd / market.priceNative : null;
  return { usd: market.liquidityUsd, exitUsd: exitLiquidityUsd(market), source: 'dexscreener', quoteUsd };
}

function changeFromPeak(history: readonly LiquiditySnapshot[], current: number | null, now: number): number | null {
  const recent = history.filter((h) => h.at >= now - HOUR && h.at < now);
  if (current === null || recent.length === 0) return null;
  const peak = Math.max(...recent.map((h) => h.liquidityUsd), current);
  return peak > 0 ? ((current - peak) / peak) * 100 : null;
}

/** Liquidity, slippage and activity for one watched pool. */
export function assessLiquidity(input: LiquidityInput): LiquidityReport {
  const { market, reserves, settings, thbPerUsd, now } = input;
  const reasons: string[] = [];
  const flags: LiquidityFlag[] = [];
  const act = activityOf(input.activity, settings);
  reasons.push(act.reason);

  const value = poolValue(market, reserves);
  const liquidityThb = value.usd !== null && thbPerUsd !== null ? value.usd * thbPerUsd : null;
  const exitLiquidityThb = value.exitUsd !== null && thbPerUsd !== null ? value.exitUsd * thbPerUsd : null;
  const oneSided = value.usd !== null && value.usd > 0 && value.exitUsd !== null && value.exitUsd / value.usd < ONE_SIDED_SHARE * 2;
  if (oneSided) {
    flags.push('ONE_SIDED');
    reasons.push(`สภาพคล่องเกือบทั้งหมดเป็นตัว token เอง ฝั่งเงิน (SOL/ETH/BNB/USDC) มีแค่ $${((value.exitUsd ?? 0) / 2).toFixed(2)} ขายออกได้น้อยมาก`);
  }
  if (reserves && market?.liquidityQuote && market.liquidityQuote > 0) {
    const gap = Math.abs(reserves.quoteReserve - market.liquidityQuote) / market.liquidityQuote;
    if (gap > RESERVES_TOLERANCE) flags.push('RESERVES_MISMATCH');
  }

  const tradeUsd = thbPerUsd ? settings.testTradeThb / thbPerUsd : null;
  let slip: { buyPct: number; sellPct: number } | null = null;
  let method: SlippageMethod = 'NONE';
  if (tradeUsd !== null && reserves && value.quoteUsd) {
    slip = estimateSlippage(reserves.tokenReserve, reserves.quoteReserve, tradeUsd / value.quoteUsd, input.poolFee ?? DEFAULT_V2_FEE);
    method = 'V2_RESERVES';
  } else if (tradeUsd !== null && market?.liquidityBase && market.liquidityQuote && value.quoteUsd) {
    // Concentrated-liquidity pool: full-range estimate from DexScreener's reported amounts (overstates impact).
    const est = estimateSlippage(market.liquidityBase, market.liquidityQuote, tradeUsd / value.quoteUsd, input.poolFee ?? DEFAULT_V2_FEE);
    // One-sided position: buying walks liquidity above the price that we cannot see; only the sell side is meaningful.
    slip = oneSided ? { buyPct: Number.NaN, sellPct: est.sellPct } : est;
    method = 'CONSTANT_PRODUCT_ESTIMATE';
  }
  const buySlippagePct = slip && Number.isFinite(slip.buyPct) ? slip.buyPct : null;
  const sellSlippagePct = slip ? slip.sellPct : null;

  let liquidity: LiquidityStatus = 'OK';
  // Judge on what can be sold into when known; the headline pool value can be mostly the token itself.
  const judged = exitLiquidityThb ?? liquidityThb;
  if (judged === null) {
    liquidity = 'UNKNOWN';
    reasons.push(value.usd === null ? 'ไม่ทราบสภาพคล่องของ pool' : 'ไม่มีอัตรา THB/USD');
  } else if (judged < settings.minLiquidityThb) {
    liquidity = 'INSUFFICIENT_LIQUIDITY';
    reasons.push(`สภาพคล่องที่ขายออกได้ ฿${Math.round(judged).toLocaleString('en-US')} ต่ำกว่าเกณฑ์ ฿${settings.minLiquidityThb.toLocaleString('en-US')}`);
  }
  const worstSlip = Math.max(buySlippagePct ?? 0, sellSlippagePct ?? 0);
  if (slip && worstSlip > settings.maxSlippagePct) {
    liquidity = 'INSUFFICIENT_LIQUIDITY';
    const fmt = (n: number | null): string => (n === null ? 'ประเมินไม่ได้' : `${n.toFixed(1)}%`);
    reasons.push(`ซื้อ/ขาย ฿${settings.testTradeThb.toLocaleString('en-US')} เสียราคา ${fmt(buySlippagePct)} / ${fmt(sellSlippagePct)} (เกิน ${settings.maxSlippagePct}%)`);
  }
  if (method === 'CONSTANT_PRODUCT_ESTIMATE') reasons.push('slippage เป็นค่าประมาณ (pool แบบ concentrated liquidity)');

  const change = changeFromPeak(input.history, value.usd, now);
  if (change !== null && change <= DROP_ALERT_PCT) {
    flags.push('LIQUIDITY_DROP');
    reasons.push(`สภาพคล่องลดลง ${Math.abs(change).toFixed(0)}% จากจุดสูงสุดใน 1 ชม. (อาจมีการถอน LP)`);
  }
  if (change !== null && act.status === 'ACTIVE') {
    const oldest = input.history.filter((h) => h.at >= now - HOUR).sort((a, b) => a.at - b.at)[0];
    if (oldest && value.usd !== null && oldest.liquidityUsd > 0 && ((value.usd - oldest.liquidityUsd) / oldest.liquidityUsd) * 100 >= GROWING_PCT) flags.push('LIQUIDITY_GROWING');
  }

  return {
    activity: act.status, liquidity, liquidityUsd: value.usd, liquidityThb, liquiditySource: value.source,
    exitLiquidityUsd: value.exitUsd, exitLiquidityThb,
    buySlippagePct, sellSlippagePct, slippageMethod: method,
    testTradeThb: settings.testTradeThb,
    poolAgeMin: market?.pairCreatedAt ? Math.max(0, (now - market.pairCreatedAt) / 60_000) : null,
    changeFromPeak60mPct: change, flags, reasons,
  };
}

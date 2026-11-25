import type { FxRate } from '../enrich/prices.ts';
import type { MarketSnapshot } from '../analysis/market.ts';

export type McapStatus = 'VERIFIED' | 'ESTIMATED' | 'UNVERIFIED';

/** Token supply read from the chain itself (not from an aggregator). */
export interface OnchainSupply {
  /** Whole-token units (already divided by 10^decimals). */
  readonly totalSupply: number;
  readonly decimals: number;
  /** Tokens sitting in burn addresses (0x…dEaD, 0x0); 0 where burning reduces supply itself (Solana). */
  readonly burned: number;
  readonly source: string;
  readonly at: number;
}

export interface MarketCapReport {
  readonly status: McapStatus;
  readonly reason: string;
  readonly method: string;
  readonly priceUsd: number | null;
  readonly totalSupply: number | null;
  readonly circulatingSupply: number | null;
  /** Memecoins rarely declare a cap; null means "not declared", not "unlimited". */
  readonly maxSupply: number | null;
  readonly circulatingMcapUsd: number | null;
  readonly fdvUsd: number | null;
  /** DexScreener's own numbers, kept separately for comparison. */
  readonly dexMarketCapUsd: number | null;
  readonly dexFdvUsd: number | null;
  readonly fx: FxRate | null;
  readonly circulatingMcapThb: number | null;
  readonly fdvThb: number | null;
  readonly sources: readonly string[];
  readonly checkedAt: number;
}

/** On-chain FDV within this share of DexScreener's FDV counts as an independent confirmation. */
const VERIFY_TOLERANCE = 0.05;
const ESTIMATE_TOLERANCE = 0.2;

function thb(usd: number | null, fx: FxRate | null): number | null {
  return usd === null || fx === null ? null : usd * fx.thbPerUsd;
}

function relativeGap(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Market cap with an explicit trust level. VERIFIED needs on-chain supply AND a price whose
 * implied FDV matches DexScreener's independently computed FDV. FDV is never shown as market cap.
 */
export function verifyMarketCap(market: MarketSnapshot | null, supply: OnchainSupply | null, fx: FxRate | null, now: number): MarketCapReport {
  const price = market?.priceUsd ?? null;
  const base = {
    priceUsd: price,
    maxSupply: null,
    dexMarketCapUsd: market?.marketCapUsd ?? null,
    dexFdvUsd: market?.fdvUsd ?? null,
    fx,
    checkedAt: now,
  };
  const sources = [...(market ? ['dexscreener'] : []), ...(supply ? [supply.source] : []), ...(fx ? [fx.source] : [])];

  if (price === null || price <= 0) {
    return { ...base, status: 'UNVERIFIED', reason: 'ไม่มีราคาจาก DEX', method: 'none', totalSupply: supply?.totalSupply ?? null,
      circulatingSupply: null, circulatingMcapUsd: null, fdvUsd: null, circulatingMcapThb: null, fdvThb: null, sources };
  }

  if (!supply || supply.totalSupply <= 0) {
    const est = market?.marketCapUsd ?? null;
    return { ...base, status: est === null ? 'UNVERIFIED' : 'ESTIMATED', reason: 'อ่าน supply บน chain ไม่ได้ ใช้ตัวเลขของ DexScreener',
      method: 'dexscreener.marketCap', totalSupply: null, circulatingSupply: null, circulatingMcapUsd: est, fdvUsd: market?.fdvUsd ?? null,
      circulatingMcapThb: thb(est, fx), fdvThb: thb(market?.fdvUsd ?? null, fx), sources };
  }

  const circulating = Math.max(0, supply.totalSupply - supply.burned);
  const fdv = price * supply.totalSupply;
  const mcap = price * circulating;
  const dexFdv = market?.fdvUsd ?? null;
  const gap = dexFdv !== null && dexFdv > 0 ? relativeGap(fdv, dexFdv) : null;
  const status: McapStatus = gap === null ? 'ESTIMATED' : gap <= VERIFY_TOLERANCE ? 'VERIFIED' : gap <= ESTIMATE_TOLERANCE ? 'ESTIMATED' : 'UNVERIFIED';
  const reason = gap === null
    ? 'มี supply บน chain แต่ไม่มี FDV ของ DexScreener ไว้เทียบ'
    : `FDV จาก supply บน chain ต่างจาก DexScreener ${(gap * 100).toFixed(1)}%`;
  return {
    ...base, status, reason,
    method: 'price(dexscreener) x (onchain totalSupply - burned)',
    totalSupply: supply.totalSupply, circulatingSupply: circulating,
    circulatingMcapUsd: mcap, fdvUsd: fdv, circulatingMcapThb: thb(mcap, fx), fdvThb: thb(fdv, fx), sources,
  };
}

export type RangePosition = 'BELOW' | 'IN_RANGE' | 'ABOVE' | 'UNKNOWN';

/** Where a verified market cap sits against the user's THB range. Unverified caps are UNKNOWN. */
export function rangePosition(report: MarketCapReport, minThb: number, maxThb: number): RangePosition {
  const cap = report.circulatingMcapThb;
  if (report.status === 'UNVERIFIED' || cap === null) return 'UNKNOWN';
  if (cap < minThb) return 'BELOW';
  return cap > maxThb ? 'ABOVE' : 'IN_RANGE';
}

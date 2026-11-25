import { buyerWindows, type WindowStats } from './buyer-stats.ts';
import { clusterWallets, type WalletCluster } from './clustering.ts';
import type { SwapRow } from './swap-store.ts';

export type AccumulationStatus =
  | 'INSUFFICIENT_DATA'
  | 'QUIET'
  | 'ACCUMULATING'
  | 'PRE_PUMP'
  | 'ALREADY_PUMPED'
  | 'SUSPICIOUS';

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PriceContext {
  readonly changeM5Pct: number | null;
  readonly changeH1Pct: number | null;
}

export interface AccumulationInput {
  readonly swaps: readonly SwapRow[];
  readonly now: number;
  /** Swaps are complete from this time on. */
  readonly coverageSince: number;
  /** Lower-cased addresses of followed (smart money) wallets on this chain. */
  readonly smartWallets: ReadonlySet<string>;
  readonly price: PriceContext | null;
}

export interface AccumulationReport {
  readonly status: AccumulationStatus;
  readonly confidence: Confidence;
  readonly reasons: readonly string[];
  readonly metrics: {
    readonly independentBuyers5m: number;
    readonly independentBuyers15m: number;
    /** Independent buyers per 5 minutes over the 10 minutes before the last 5. */
    readonly baselinePer5m: number | null;
    /** Last 5 minutes vs baseline; null when the baseline is not covered. */
    readonly acceleration: number | null;
    /** Buys / (buys + sells) by transaction count. */
    readonly buyPressure5m: number | null;
    readonly buyPressure15m: number | null;
    /** Wallets that bought and did not sell in the last 15 minutes. */
    readonly netAccumulators15m: number;
    readonly repeatBuyers15m: number;
    /** Share of 15-minute buyers that sit in a coordinated cluster. */
    readonly clusteredShare15m: number;
    readonly smartMoneyBuyers60m: number;
    readonly priceChangeH1Pct: number | null;
  };
  readonly clusters: readonly WalletCluster[];
  readonly windows: readonly WindowStats[];
}

/** Thresholds (named so the dashboard can expose them later). */
export const ACCUMULATION_RULES = {
  minBuys15m: 5,
  prePumpAcceleration: 2,
  prePumpMinBuyers5m: 5,
  minBuyPressure: 0.55,
  accumulatingMinBuyers15m: 8,
  accumulatingMinHolders15m: 5,
  /** Above this 1-hour price rise the move already happened. */
  pumpedH1Pct: 100,
  pumpedM5Pct: 30,
  /** "Price has not run yet" for pre-pump / accumulation. */
  calmH1Pct: 50,
  suspiciousClusterShare: 0.5,
  suspiciousMinClustered: 4,
} as const;

const MIN = 60_000;

function pressure(buys: number, sells: number): number | null {
  return buys + sells > 0 ? buys / (buys + sells) : null;
}

function independent(swaps: readonly SwapRow[], rootOf: ReadonlyMap<string, string>, from: number, to: number): number {
  const roots = swaps.filter((s) => s.side === 'BUY' && s.blockTime > from && s.blockTime <= to).map((s) => rootOf.get(s.wallet) ?? s.wallet);
  return new Set(roots).size;
}

function netAccumulators(swaps: readonly SwapRow[], since: number): number {
  const net = new Map<string, { bought: boolean; sold: boolean }>();
  for (const s of swaps) {
    if (s.blockTime <= since) continue;
    const prev = net.get(s.wallet) ?? { bought: false, sold: false };
    net.set(s.wallet, s.side === 'BUY' ? { ...prev, bought: true } : { ...prev, sold: true });
  }
  return [...net.values()].filter((v) => v.bought && !v.sold).length;
}

function confidenceOf(windows: readonly WindowStats[], price: PriceContext | null): Confidence {
  const w15 = windows.find((w) => w.minutes === 15);
  const w60 = windows.find((w) => w.minutes === 60);
  if (w60?.complete && w60.buys >= 20 && price !== null && price.changeH1Pct !== null) return 'HIGH';
  if (w15?.complete) return 'MEDIUM';
  return 'LOW';
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Accumulation and pre-pump detection for one token from its recorded swaps. Looks at the
 * change in independent buyers (acceleration), not raw volume, and refuses to call a pattern
 * when the data does not cover the windows it needs.
 */
export function detectAccumulation(input: AccumulationInput): AccumulationReport {
  const { swaps, now, coverageSince, smartWallets, price } = input;
  const R = ACCUMULATION_RULES;
  const windows = buyerWindows(swaps, now, coverageSince);
  const w5 = windows.find((w) => w.minutes === 5)!;
  const w15 = windows.find((w) => w.minutes === 15)!;
  const { rootOf, clusters } = clusterWallets(swaps.filter((s) => s.blockTime > now - 60 * MIN));

  const independentBuyers5m = independent(swaps, rootOf, now - 5 * MIN, now);
  const independentBuyers15m = independent(swaps, rootOf, now - 15 * MIN, now);
  const baselinePer5m = w15.complete ? independent(swaps, rootOf, now - 15 * MIN, now - 5 * MIN) / 2 : null;
  const acceleration = baselinePer5m === null ? null : independentBuyers5m / Math.max(baselinePer5m, 1);
  const buyers15 = new Set(swaps.filter((s) => s.side === 'BUY' && s.blockTime > now - 15 * MIN).map((s) => s.wallet));
  const inCluster = new Set(clusters.flatMap((c) => c.wallets));
  const clustered = [...buyers15].filter((w) => inCluster.has(w)).length;
  const clusteredShare15m = buyers15.size > 0 ? clustered / buyers15.size : 0;
  const smartMoneyBuyers60m = new Set(swaps.filter((s) => s.side === 'BUY' && s.blockTime > now - 60 * MIN && smartWallets.has(s.wallet)).map((s) => s.wallet)).size;
  const metrics = {
    independentBuyers5m, independentBuyers15m, baselinePer5m, acceleration,
    buyPressure5m: pressure(w5.buys, w5.sells), buyPressure15m: pressure(w15.buys, w15.sells),
    netAccumulators15m: netAccumulators(swaps, now - 15 * MIN), repeatBuyers15m: w15.multiBuyWallets,
    clusteredShare15m, smartMoneyBuyers60m, priceChangeH1Pct: price?.changeH1Pct ?? null,
  };
  const confidence = confidenceOf(windows, price);
  const base = { confidence, metrics, clusters, windows };

  if (!w15.complete || w15.buys < R.minBuys15m) {
    const why = !w15.complete ? 'ยังเก็บข้อมูลไม่ครบ 15 นาที' : `ซื้อใน 15 นาทีมีแค่ ${w15.buys} ครั้ง`;
    return { ...base, status: 'INSUFFICIENT_DATA', confidence: 'LOW', reasons: [why] };
  }
  if (clusteredShare15m >= R.suspiciousClusterShare && clustered >= R.suspiciousMinClustered) {
    return { ...base, status: 'SUSPICIOUS', reasons: [`ผู้ซื้อ ${pct(clusteredShare15m)} (${clustered} กระเป๋า) มีพฤติกรรมเป็นกลุ่มเดียวกัน (ซื้อ block เดียวกัน + fee/กระเป๋าใหม่/ขนาดเท่ากัน) อาจเป็นการปั่น`] };
  }
  const h1 = price?.changeH1Pct ?? null;
  const m5 = price?.changeM5Pct ?? null;
  if ((h1 !== null && h1 >= R.pumpedH1Pct) || (m5 !== null && m5 >= R.pumpedM5Pct)) {
    return { ...base, status: 'ALREADY_PUMPED', reasons: [`ราคาขึ้นไปแล้ว (1 ชม. ${h1?.toFixed(0) ?? '-'}%, 5 นาที ${m5?.toFixed(0) ?? '-'}%)`] };
  }

  const calm = h1 === null || h1 < R.calmH1Pct;
  const reasons: string[] = [];
  if (smartMoneyBuyers60m > 0) reasons.push(`กระเป๋าที่ติดตาม (smart money) ซื้อ ${smartMoneyBuyers60m} กระเป๋าใน 1 ชม.`);
  if (h1 === null) reasons.push('ไม่มีข้อมูลราคา 1 ชม. (ยังตัดกรณีราคาขึ้นไปแล้วไม่ได้)');

  const p5 = metrics.buyPressure5m ?? 0;
  if (calm && acceleration !== null && acceleration >= R.prePumpAcceleration && independentBuyers5m >= R.prePumpMinBuyers5m && p5 >= R.minBuyPressure) {
    return {
      ...base, status: 'PRE_PUMP',
      reasons: [`ผู้ซื้ออิสระเร่งขึ้น ${acceleration.toFixed(1)} เท่า (${baselinePer5m} → ${independentBuyers5m} ต่อ 5 นาที)`, `แรงซื้อ 5 นาที ${pct(p5)}`, ...reasons],
    };
  }
  const p15 = metrics.buyPressure15m ?? 0;
  if (calm && independentBuyers15m >= R.accumulatingMinBuyers15m && metrics.netAccumulators15m >= R.accumulatingMinHolders15m && p15 >= R.minBuyPressure) {
    return {
      ...base, status: 'ACCUMULATING',
      reasons: [`ผู้ซื้ออิสระ ${independentBuyers15m} ราย ใน 15 นาที, ${metrics.netAccumulators15m} รายซื้อแล้วยังไม่ขาย`, `แรงซื้อ 15 นาที ${pct(p15)}`, ...reasons],
    };
  }
  return { ...base, status: 'QUIET', reasons: [`ผู้ซื้ออิสระ ${independentBuyers15m} ราย ใน 15 นาที, แรงซื้อ ${pct(p15)}`, ...reasons] };
}

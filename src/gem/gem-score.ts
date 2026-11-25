import type { MarketSnapshot } from '../analysis/market.ts';
import type { AccumulationReport } from './accumulation.ts';
import type { LiquidityReport } from './liquidity.ts';
import type { MarketCapReport, RangePosition } from './market-cap.ts';
import type { SecurityAssessment } from './security-engine.ts';

export const SCORE_CATEGORIES = [
  'smartMoney', 'uniqueBuyersGrowth', 'buySellPressure', 'volumeAcceleration', 'liquidityQuality',
  'holderGrowth', 'socialMomentum', 'marketCapPosition', 'priceMomentumQuality', 'riskAssessment',
] as const;
export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];
export type ScoreWeights = Readonly<Record<ScoreCategory, number>>;

/** Default weights from the V2 spec (Phase 8); adjustable in settings. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  smartMoney: 20, uniqueBuyersGrowth: 20, buySellPressure: 15, volumeAcceleration: 10, liquidityQuality: 10,
  holderGrowth: 5, socialMomentum: 5, marketCapPosition: 5, priceMomentumQuality: 5, riskAssessment: 5,
};

export type GemClass = 'HIGH_POTENTIAL' | 'EARLY_WATCH' | 'LOW_ACTIVITY' | 'HIGH_RISK' | 'REJECTED';

export interface ScoreThresholds {
  readonly highPotentialScore: number;
  readonly highPotentialMinConfidence: number;
  readonly earlyWatchScore: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = { highPotentialScore: 70, highPotentialMinConfidence: 60, earlyWatchScore: 40 };

export interface ScoreInput {
  readonly accumulation: AccumulationReport;
  readonly liquidity: LiquidityReport;
  readonly security: SecurityAssessment;
  readonly marketCap: MarketCapReport | null;
  readonly rangePosition: RangePosition;
  readonly market: MarketSnapshot | null;
  /** Followed wallets on this chain; 0 = smart money cannot be judged at all. */
  readonly trackedWallets: number;
  /** News items naming the symbol in the last 24 h; null when the symbol cannot be matched safely. */
  readonly newsMentions24h: number | null;
  readonly weights: ScoreWeights;
  readonly thresholds: ScoreThresholds;
}

export interface CategoryScore {
  readonly category: ScoreCategory;
  readonly weight: number;
  /** Points earned (0..weight). Missing evidence always earns 0. */
  readonly points: number;
  /** False when the data needed for this category is missing or unverifiable. */
  readonly evidence: boolean;
  readonly note: string;
}

export interface GemScore {
  /** 0–100: points earned over the total weight. Unknown categories count as 0, never as positive. */
  readonly score: number;
  /** 0–100: share of the total weight that rested on real evidence. */
  readonly confidence: number;
  readonly classification: GemClass;
  readonly gateReasons: readonly string[];
  readonly categories: readonly CategoryScore[];
}

type Part = { fraction: number; evidence: boolean; note: string };
const none = (note: string): Part => ({ fraction: 0, evidence: false, note });
const clamp = (n: number): number => Math.max(0, Math.min(1, n));

function smartMoney(i: ScoreInput): Part {
  if (i.trackedWallets === 0) return none('ยังไม่มีกระเป๋า smart money ที่ติดตามบน chain นี้');
  const w60 = i.accumulation.windows.find((w) => w.minutes === 60);
  const w15 = i.accumulation.windows.find((w) => w.minutes === 15);
  if (!w60?.complete && !w15?.complete) return none('ข้อมูลการซื้อยังไม่ครบ');
  const n = i.accumulation.metrics.smartMoneyBuyers60m;
  return { fraction: n >= 3 ? 1 : n === 2 ? 0.75 : n === 1 ? 0.5 : 0, evidence: true, note: `smart money ซื้อ ${n} กระเป๋า` };
}

function buyersGrowth(i: ScoreInput): Part {
  const m = i.accumulation.metrics;
  if (m.acceleration === null) return none('ยังไม่มีข้อมูลครบ 15 นาทีให้เทียบการเติบโต');
  const a = m.acceleration;
  const accel = a >= 3 ? 0.6 : a >= 2 ? 0.45 : a >= 1.3 ? 0.25 : a >= 1 ? 0.1 : 0;
  const breadth = 0.4 * clamp(m.independentBuyers15m / 30);
  return { fraction: accel + breadth, evidence: true, note: `ผู้ซื้ออิสระ ${m.independentBuyers15m} ราย/15 นาที, เร่ง ${a.toFixed(1)} เท่า` };
}

function pressure(i: ScoreInput): Part {
  const w15 = i.accumulation.windows.find((w) => w.minutes === 15);
  const p = i.accumulation.metrics.buyPressure15m;
  if (!w15?.complete || p === null || w15.buys + w15.sells < 5) return none('ธุรกรรมยังน้อยเกินไปที่จะวัดแรงซื้อ');
  return { fraction: clamp((p - 0.5) / 0.2), evidence: true, note: `แรงซื้อ ${(p * 100).toFixed(0)}%` };
}

function volumeAccel(i: ScoreInput): Part {
  const v = i.market?.volumeUsd;
  if (!v || v.h1 <= 0) return none('ไม่มีข้อมูล volume 1 ชม.');
  const r = v.m5 / (v.h1 / 12);
  return { fraction: r >= 3 ? 1 : r >= 2 ? 0.7 : r >= 1.3 ? 0.4 : 0, evidence: true, note: `volume 5 นาที = ${r.toFixed(1)} เท่าของค่าเฉลี่ย` };
}

function liquidityQuality(i: ScoreInput): Part {
  const l = i.liquidity;
  if (l.liquidity === 'UNKNOWN') return none('ไม่ทราบสภาพคล่อง');
  if (l.liquidity === 'INSUFFICIENT_LIQUIDITY') return { fraction: 0, evidence: true, note: 'สภาพคล่องไม่พอ' };
  const sell = l.sellSlippagePct;
  const slip = sell === null ? 0 : sell <= 2 ? 0.4 : sell <= 5 ? 0.25 : sell <= 10 ? 0.1 : 0;
  const growing = l.flags.includes('LIQUIDITY_GROWING') ? 0.1 : 0;
  return { fraction: clamp(0.5 + slip + growing), evidence: true, note: `สภาพคล่องผ่าน, ขาย ฿${l.testTradeThb.toLocaleString('en-US')} เสีย ${sell === null ? '-' : `${sell.toFixed(1)}%`}` };
}

function social(i: ScoreInput): Part {
  if (i.newsMentions24h === null) return none('ชื่อเหรียญสั้นหรือซ้ำเกินไป จับคู่ข่าวไม่ได้');
  const n = i.newsMentions24h;
  return { fraction: n >= 2 ? 1 : n === 1 ? 0.6 : 0, evidence: true, note: `ข่าว/กระแสที่พูดถึง ${n} ครั้งใน 24 ชม.` };
}

function marketCapPosition(i: ScoreInput): Part {
  if (!i.marketCap || i.marketCap.status === 'UNVERIFIED' || i.rangePosition === 'UNKNOWN') return none('market cap ยังตรวจสอบไม่ได้');
  const verified = i.marketCap.status === 'VERIFIED';
  const f = i.rangePosition === 'IN_RANGE' ? (verified ? 1 : 0.6) : i.rangePosition === 'BELOW' ? 0.2 : 0;
  return { fraction: f, evidence: true, note: `market cap ${i.rangePosition} (${i.marketCap.status})` };
}

function priceQuality(i: ScoreInput): Part {
  const h1 = i.market?.priceChangePct.h1 ?? null;
  if (h1 === null) return none('ไม่มีข้อมูลราคา 1 ชม.');
  const f = h1 >= 0 && h1 < 50 ? 1 : h1 >= 50 && h1 < 100 ? 0.4 : h1 < 0 && h1 >= -20 ? 0.4 : 0;
  return { fraction: f, evidence: true, note: `ราคา 1 ชม. ${h1.toFixed(0)}%` };
}

function risk(i: ScoreInput): Part {
  const level = i.security.level;
  if (level === 'UNKNOWN') return none('ตรวจความปลอดภัยหลักไม่ได้');
  return { fraction: level === 'NO_ISSUES_FOUND' ? 1 : level === 'CAUTION' ? 0.6 : 0, evidence: true, note: `security ${level}` };
}

const SCORERS: Readonly<Record<ScoreCategory, (i: ScoreInput) => Part>> = {
  smartMoney, uniqueBuyersGrowth: buyersGrowth, buySellPressure: pressure, volumeAcceleration: volumeAccel,
  liquidityQuality, holderGrowth: () => none('ไม่มีแหล่งข้อมูลจำนวน holder ย้อนหลังแบบฟรี'),
  socialMomentum: social, marketCapPosition, priceMomentumQuality: priceQuality, riskAssessment: risk,
};

/** Hard gate: checked before and independently of the score; no score can buy past it. */
function gate(i: ScoreInput): { cls: GemClass; reasons: string[] } | null {
  const reasons: string[] = [];
  if (i.security.level === 'CRITICAL') reasons.push(...i.security.reasons.slice(0, 3));
  if (i.liquidity.flags.includes('LIQUIDITY_DROP')) reasons.push('สภาพคล่องถูกถอนออก');
  if (i.accumulation.status === 'ALREADY_PUMPED') reasons.push('ราคาขึ้นไปแล้ว ไม่ใช่ช่วงต้น');
  if (i.rangePosition === 'ABOVE') reasons.push('market cap เกินช่วงที่ตั้งไว้');
  if (reasons.length > 0) return { cls: 'REJECTED', reasons };
  if (i.security.level === 'HIGH_RISK') reasons.push(...i.security.reasons.slice(0, 3));
  if (i.accumulation.status === 'SUSPICIOUS') reasons.push(...i.accumulation.reasons.slice(0, 1));
  if (i.liquidity.liquidity === 'INSUFFICIENT_LIQUIDITY') reasons.push('สภาพคล่องไม่พอสำหรับการซื้อขายอย่างปลอดภัย');
  if (reasons.length > 0) return { cls: 'HIGH_RISK', reasons };
  if (i.liquidity.activity !== 'ACTIVE' || i.accumulation.status === 'INSUFFICIENT_DATA') {
    return { cls: 'LOW_ACTIVITY', reasons: [i.liquidity.reasons[0] ?? 'การซื้อขายยังน้อย'] };
  }
  return null;
}

/**
 * Early Gem Score. The score never compensates for a failed gate, unknown data earns no
 * points, and HIGH_POTENTIAL additionally needs verified market cap and checkable security.
 * A high score is not a prediction that the price will rise.
 */
export function scoreGem(i: ScoreInput): GemScore {
  const total = SCORE_CATEGORIES.reduce((sum, c) => sum + Math.max(0, i.weights[c]), 0) || 1;
  const categories = SCORE_CATEGORIES.map((category): CategoryScore => {
    const weight = Math.max(0, i.weights[category]);
    const p = SCORERS[category](i);
    return { category, weight, points: p.evidence ? weight * clamp(p.fraction) : 0, evidence: p.evidence, note: p.note };
  });
  const score = Math.round((categories.reduce((s, c) => s + c.points, 0) / total) * 1000) / 10;
  const confidence = Math.round((categories.filter((c) => c.evidence).reduce((s, c) => s + c.weight, 0) / total) * 1000) / 10;
  const gated = gate(i);
  if (gated) return { score, confidence, classification: gated.cls, gateReasons: gated.reasons, categories };

  const t = i.thresholds;
  const blockers: string[] = [];
  if (i.marketCap?.status !== 'VERIFIED') blockers.push('market cap ยังไม่ VERIFIED');
  if (i.security.level === 'UNKNOWN') blockers.push('ตรวจความปลอดภัยหลักไม่ได้');
  if (confidence < t.highPotentialMinConfidence) blockers.push(`ความมั่นใจของข้อมูล ${confidence}% ต่ำกว่า ${t.highPotentialMinConfidence}%`);
  if (score >= t.highPotentialScore && blockers.length === 0) return { score, confidence, classification: 'HIGH_POTENTIAL', gateReasons: [], categories };
  if (score >= t.earlyWatchScore) {
    // Always say what stands between this token and HIGH_POTENTIAL.
    const missing = score < t.highPotentialScore ? [`คะแนน ${score} ยังไม่ถึง ${t.highPotentialScore}`, ...blockers] : blockers;
    return { score, confidence, classification: 'EARLY_WATCH', gateReasons: missing, categories };
  }
  return { score, confidence, classification: 'LOW_ACTIVITY', gateReasons: [`คะแนน ${score} ต่ำกว่า ${t.earlyWatchScore}`], categories };
}

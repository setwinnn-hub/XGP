import { exitLiquidityUsd, type MarketSnapshot } from './market.ts';
import { isVerified, type SecurityReport } from './security.ts';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ScoreContext {
  /** Followed wallets that bought this token (distinct wallets). */
  readonly smartMoneyBuyers: number;
  /** Fresh news mentions of the token's symbol. */
  readonly newsMentions: number;
  readonly now: number;
}

export interface TokenScore {
  /** 0–100: how strong the early signals are. Not a price prediction. */
  readonly opportunity: number;
  /** Signal points before the risk cap; shows that a risky token is getting attention. */
  readonly rawOpportunity: number;
  readonly risk: RiskLevel;
  readonly positives: readonly string[];
  readonly risks: readonly string[];
}

interface Finding {
  readonly points: number;
  readonly text: string;
}

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function usd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Below this share of the reported liquidity, the quote side is too thin to be a real pool. */
const MIN_QUOTE_SHARE = 0.1;

/** Liquidity a seller can exit into when the quote side is known, else DexScreener's figure. */
function realLiquidityUsd(m: MarketSnapshot): number | null {
  return exitLiquidityUsd(m) ?? m.liquidityUsd;
}

function marketFindings(m: MarketSnapshot): Finding[] {
  const out: Finding[] = [];
  const { buys, sells } = m.txnsH1;
  const total = buys + sells;
  if (m.volumeUsd.h1 >= 50_000) out.push({ points: 20, text: `Volume 1 ชม. สูง ${usd(m.volumeUsd.h1)}` });
  else if (m.volumeUsd.h1 >= 10_000) out.push({ points: 10, text: `Volume 1 ชม. ${usd(m.volumeUsd.h1)}` });
  if (m.volumeUsd.h1 > 0 && m.volumeUsd.m5 * 12 >= m.volumeUsd.h1 * 2) out.push({ points: 10, text: 'Volume 5 นาทีล่าสุดเร่งขึ้นแรงเมื่อเทียบกับค่าเฉลี่ยชั่วโมง' });
  if (total >= 30 && buys / total >= 0.6) out.push({ points: 15, text: `แรงซื้อมากกว่าแรงขาย (${buys} ซื้อ / ${sells} ขาย ใน 1 ชม.)` });
  if (total >= 100) out.push({ points: 5, text: `มีการซื้อขายคึกคัก ${total} ครั้ง/ชม.` });
  const liq = realLiquidityUsd(m);
  if ((liq ?? 0) >= 50_000) out.push({ points: 10, text: `สภาพคล่องดี ${usd(liq ?? 0)}` });
  const h1 = m.priceChangePct.h1;
  if (h1 !== null && h1 >= 20 && h1 <= 1_000) out.push({ points: 10, text: `ราคา 1 ชม. +${h1.toFixed(0)}%` });
  if (m.socials + m.websites >= 2) out.push({ points: 5, text: 'มีเว็บไซต์/โซเชียลของโปรเจกต์' });
  return out;
}

function contextFindings(c: ScoreContext, m: MarketSnapshot | null): Finding[] {
  const out: Finding[] = [];
  if (c.smartMoneyBuyers >= 2) out.push({ points: 20, text: `Wallet ที่ติดตาม ${c.smartMoneyBuyers} ตัวซื้อเหรียญนี้` });
  else if (c.smartMoneyBuyers === 1) out.push({ points: 10, text: 'Wallet ที่ติดตามซื้อเหรียญนี้' });
  if (c.newsMentions > 0) out.push({ points: Math.min(15, c.newsMentions * 5), text: `ถูกพูดถึงในข่าว ${c.newsMentions} ครั้ง` });
  if (m?.pairCreatedAt && c.now - m.pairCreatedAt < 24 * 3_600_000) out.push({ points: 5, text: 'ยังเป็นเหรียญใหม่ (อายุไม่ถึง 24 ชม.)' });
  return out;
}

interface RiskFinding {
  readonly level: RiskLevel;
  readonly text: string;
}

function securityRisks(s: SecurityReport): RiskFinding[] {
  const out: RiskFinding[] = [];
  if (s.honeypot) out.push({ level: 'CRITICAL', text: 'Honeypot: ซื้อได้แต่ขายไม่ได้' });
  if (s.cannotSellAll) out.push({ level: 'HIGH', text: 'ขายทั้งหมดไม่ได้ (cannot sell all)' });
  if ((s.sellTaxPct ?? 0) > 10) out.push({ level: 'HIGH', text: `ภาษีขาย ${(s.sellTaxPct ?? 0).toFixed(0)}%` });
  if ((s.buyTaxPct ?? 0) > 10) out.push({ level: 'MEDIUM', text: `ภาษีซื้อ ${(s.buyTaxPct ?? 0).toFixed(0)}%` });
  if (s.ownerCanChangeBalance) out.push({ level: 'HIGH', text: 'เจ้าของแก้ยอดเหรียญในกระเป๋าคนอื่นได้' });
  if (s.mintable) out.push({ level: 'HIGH', text: 'ยังผลิตเหรียญเพิ่มได้ (mintable)' });
  if (s.freezable) out.push({ level: 'HIGH', text: 'เจ้าของ freeze กระเป๋าได้' });
  if (s.hiddenOwner) out.push({ level: 'HIGH', text: 'มีเจ้าของแฝง (hidden owner)' });
  if (s.transferPausable) out.push({ level: 'MEDIUM', text: 'เจ้าของหยุดการโอนได้' });
  if (s.openSource === false) out.push({ level: 'MEDIUM', text: 'ไม่เปิดเผย source code ของ contract' });
  if ((s.top10HoldersPct ?? 0) > 50) out.push({ level: 'HIGH', text: `10 อันดับแรกถือ ${(s.top10HoldersPct ?? 0).toFixed(0)}% (ไม่นับ pool)` });
  if ((s.creatorPct ?? 0) > 10) out.push({ level: 'MEDIUM', text: `ผู้สร้างถือ ${(s.creatorPct ?? 0).toFixed(0)}%` });
  if (s.holderCount !== null && s.holderCount < 20) out.push({ level: 'MEDIUM', text: `ผู้ถือเพียง ${s.holderCount} ราย` });
  return out;
}

function marketRisks(m: MarketSnapshot): RiskFinding[] {
  const out: RiskFinding[] = [];
  const reported = m.liquidityUsd;
  const exit = exitLiquidityUsd(m);
  const liq = exit ?? reported;
  const onCurve = m.dexId === 'pumpfun';
  if (!onCurve && reported !== null && reported > 0 && exit !== null && exit / reported < MIN_QUOTE_SHARE) {
    out.push({ level: 'HIGH', text: `DexScreener รายงานสภาพคล่อง ${usd(reported)} แต่ฝั่งเงินจริงใน pool มีแค่ ${usd(exit / 2)} (อาจเป็น pool ปลอม/ราคาตั้งเอง ขายออกได้น้อยมาก)` });
  }
  if (!onCurve && liq !== null && liq < 5_000) out.push({ level: 'HIGH', text: `สภาพคล่องต่ำมาก ${usd(liq)}` });
  // The manipulation check uses market cap, or FDV when no market cap is published (labelled as such).
  const cap = m.marketCapUsd ?? m.fdvUsd;
  const capLabel = m.marketCapUsd !== null ? 'Market cap' : 'FDV';
  if (!onCurve && liq !== null && cap !== null && cap > 0 && liq / cap < 0.02) {
    out.push({ level: 'HIGH', text: `${capLabel} ${usd(cap)} สูงเกินสภาพคล่อง ${usd(liq)} มาก (ราคาอาจถูกปั่น)` });
  }
  const h1 = m.priceChangePct.h1;
  if (h1 !== null && h1 > 10_000) out.push({ level: 'HIGH', text: `ราคา 1 ชม. เปลี่ยน +${h1.toExponential(1)}% ผิดธรรมชาติ` });
  const txns = m.txnsH1.buys + m.txnsH1.sells;
  if (txns > 0 && m.volumeUsd.h1 / txns > 5_000 && (liq ?? 0) < 100_000) {
    out.push({ level: 'MEDIUM', text: `Volume ต่อรายการสูงผิดปกติ (${usd(m.volumeUsd.h1 / txns)}/ครั้ง) อาจเป็น volume ปลอม` });
  }
  if (m.priceChangePct.m5 !== null && m.priceChangePct.m5 < -50) out.push({ level: 'HIGH', text: `ราคาร่วง ${m.priceChangePct.m5.toFixed(0)}% ใน 5 นาที (อาจเป็น rug/dump)` });
  return out;
}

/**
 * Rule-based token score. Every point and every risk comes with a Thai reason, so the
 * user can see exactly why. A high score is not a prediction and does not mean profit.
 */
export function scoreToken(market: MarketSnapshot | null, security: SecurityReport | null, context: ScoreContext): TokenScore {
  const findings = [...(market ? marketFindings(market) : []), ...contextFindings(context, market)];
  const risks = [...(security ? securityRisks(security) : []), ...(market ? marketRisks(market) : [])];
  if (!market) risks.push({ level: 'MEDIUM', text: 'ยังไม่มีข้อมูลตลาดบน DexScreener' });
  if (!security) risks.push({ level: 'MEDIUM', text: 'ตรวจความปลอดภัยของ contract ไม่ได้ (GoPlus ไม่มีข้อมูล)' });
  else if (!isVerified(security)) risks.push({ level: 'MEDIUM', text: 'GoPlus ยังไม่มีผลตรวจความปลอดภัยของเหรียญนี้ (เหรียญใหม่มาก)' });
  const risk = risks.reduce<RiskLevel>((worst, r) => (RISK_RANK[r.level] > RISK_RANK[worst] ? r.level : worst), 'LOW');
  const raw = findings.reduce((sum, f) => sum + f.points, 0);
  const cap = risk === 'CRITICAL' ? 5 : risk === 'HIGH' ? 40 : 100;
  return {
    opportunity: Math.max(0, Math.min(100, raw, cap)),
    rawOpportunity: Math.min(100, raw),
    risk,
    positives: findings.map((f) => f.text),
    risks: [...risks].sort((a, b) => RISK_RANK[b.level] - RISK_RANK[a.level]).map((r) => `[${r.level}] ${r.text}`),
  };
}

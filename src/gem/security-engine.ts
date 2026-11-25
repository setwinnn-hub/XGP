import type { SecurityReport } from '../analysis/security.ts';
import type { ChainId } from '../core/types.ts';
import type { HoneypotResult } from './honeypot.ts';
import type { LiquidityFlag } from './liquidity.ts';
import type { PoolKind } from './swap-store.ts';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';
export type Severity = 'critical' | 'high' | 'medium';
/** Never "SAFE": a clean result only means nothing was found by the sources that answered. */
export type SecurityLevel = 'CRITICAL' | 'HIGH_RISK' | 'UNKNOWN' | 'CAUTION' | 'NO_ISSUES_FOUND';

export interface SecurityCheck {
  readonly id: string;
  readonly label: string;
  readonly severity: Severity;
  readonly status: CheckStatus;
  readonly sources: readonly string[];
  readonly detail: string | null;
}

export interface SecurityAssessment {
  readonly level: SecurityLevel;
  /** Critical findings stop Qualified Gem alerts (spec Phase 6). */
  readonly suppressGemAlert: boolean;
  readonly checks: readonly SecurityCheck[];
  /** Places where GoPlus and honeypot.is disagree; the worse answer is used. */
  readonly conflicts: readonly string[];
  readonly reasons: readonly string[];
}

export interface SecurityInput {
  readonly chain: ChainId;
  readonly poolKind: PoolKind;
  readonly goplus: SecurityReport | null;
  readonly honeypot: HoneypotResult | null;
  readonly liquidityFlags: readonly LiquidityFlag[];
}

/** Checks whose UNKNOWN makes the whole token UNKNOWN (cannot be called clean without them). */
const CORE = new Set(['honeypot', 'sell_tax', 'owner_change_balance', 'mintable']);

type Make = (id: string, label: string, severity: Severity, status: CheckStatus, sources: string[], detail?: string | null) => SecurityCheck;
const make: Make = (id, label, severity, status, sources, detail = null) => ({ id, label, severity, status, sources, detail });

/** A yes/no risk flag: true = FAIL (or WARN when softened), false = PASS, null = UNKNOWN. */
function flagCheck(id: string, label: string, severity: Severity, value: boolean | null | undefined, source: string, soften = false): SecurityCheck {
  if (value === null || value === undefined) return make(id, label, severity, 'UNKNOWN', []);
  return make(id, label, severity, value ? (soften ? 'WARN' : 'FAIL') : 'PASS', [source]);
}

function taxCheck(id: string, label: string, values: { source: string; pct: number | null | undefined }[], conflicts: string[]): SecurityCheck {
  const known = values.filter((v): v is { source: string; pct: number } => typeof v.pct === 'number');
  if (known.length === 0) return make(id, label, 'high', 'UNKNOWN', []);
  const worst = Math.max(...known.map((v) => v.pct));
  if (known.length === 2 && Math.abs(known[0]!.pct - known[1]!.pct) > 5) conflicts.push(`${label}: ${known.map((v) => `${v.source} ${v.pct.toFixed(1)}%`).join(' vs ')}`);
  const severity: Severity = worst >= 50 ? 'critical' : 'high';
  const status: CheckStatus = worst >= 10 ? 'FAIL' : worst > 5 ? 'WARN' : 'PASS';
  return make(id, label, severity, status, known.map((v) => v.source), `${worst.toFixed(1)}%`);
}

function percentCheck(id: string, label: string, pct: number | null | undefined, failAt: number, warnAt: number, source: string): SecurityCheck {
  if (pct === null || pct === undefined) return make(id, label, 'high', 'UNKNOWN', []);
  return make(id, label, 'high', pct >= failAt ? 'FAIL' : pct >= warnAt ? 'WARN' : 'PASS', [source], `${pct.toFixed(1)}%`);
}

function honeypotCheck(g: SecurityReport | null, h: HoneypotResult | null, conflicts: string[]): SecurityCheck {
  const answers = [
    { source: 'GoPlus', v: g?.honeypot ?? null },
    { source: 'honeypot.is', v: h?.status === 'SIMULATED' ? h.isHoneypot : null },
  ].filter((a): a is { source: string; v: boolean } => a.v !== null);
  if (answers.length === 0) return make('honeypot', 'Honeypot (ซื้อแล้วขายไม่ได้)', 'critical', 'UNKNOWN', [], h?.status === 'SIMULATION_FAILED' ? 'honeypot.is จำลองการซื้อขายไม่สำเร็จ' : null);
  if (answers.length === 2 && answers[0]!.v !== answers[1]!.v) conflicts.push(`Honeypot: GoPlus ${answers[0]!.v ? 'ใช่' : 'ไม่ใช่'} / honeypot.is ${answers[1]!.v ? 'ใช่' : 'ไม่ใช่'}`);
  const bad = answers.filter((a) => a.v);
  return make('honeypot', 'Honeypot (ซื้อแล้วขายไม่ได้)', 'critical', bad.length > 0 ? 'FAIL' : 'PASS', (bad.length > 0 ? bad : answers).map((a) => a.source));
}

function lpLockCheck(poolKind: PoolKind, lockedPct: number | null | undefined): SecurityCheck {
  const label = 'LP ถูก lock หรือ burn';
  if (poolKind !== 'pair') return make('lp_lock', label, 'high', 'UNKNOWN', [], 'pool แบบ V3/V4 ใช้ LP เป็น NFT ตรวจ lock ด้วยแหล่งข้อมูลฟรีไม่ได้');
  if (lockedPct === null || lockedPct === undefined) return make('lp_lock', label, 'high', 'UNKNOWN', []);
  return make('lp_lock', label, 'high', lockedPct >= 90 ? 'PASS' : lockedPct >= 50 ? 'WARN' : 'FAIL', ['GoPlus'], `${lockedPct.toFixed(1)}%`);
}

function evmChecks(input: SecurityInput, conflicts: string[]): SecurityCheck[] {
  const g = input.goplus;
  const x = g?.extra;
  const h = input.honeypot;
  const renounced = x?.ownerRenounced === true;
  const proxy = x?.proxy ?? null;
  const hpProxy = h?.isProxy ?? null;
  return [
    honeypotCheck(g, h, conflicts),
    flagCheck('cannot_sell_all', 'ขายได้ไม่หมด (cannot sell all)', 'critical', g?.cannotSellAll, 'GoPlus'),
    flagCheck('cannot_buy', 'ซื้อไม่ได้', 'high', x?.cannotBuy, 'GoPlus'),
    taxCheck('sell_tax', 'ภาษีขาย', [{ source: 'GoPlus', pct: g?.sellTaxPct }, { source: 'honeypot.is', pct: h?.sellTaxPct }], conflicts),
    taxCheck('buy_tax', 'ภาษีซื้อ', [{ source: 'GoPlus', pct: g?.buyTaxPct }, { source: 'honeypot.is', pct: h?.buyTaxPct }], conflicts),
    taxCheck('transfer_tax', 'ภาษีโอน', [{ source: 'GoPlus', pct: x?.transferTaxPct }, { source: 'honeypot.is', pct: h?.transferTaxPct }], conflicts),
    flagCheck('tax_modifiable', 'เจ้าของแก้ภาษีได้', 'high', x?.slippageModifiable, 'GoPlus'),
    flagCheck('personal_tax', 'ตั้งภาษีรายกระเป๋าได้', 'high', x?.personalSlippageModifiable, 'GoPlus'),
    flagCheck('owner_change_balance', 'เจ้าของแก้ยอดเงินของคนอื่นได้', 'critical', g?.ownerCanChangeBalance, 'GoPlus'),
    flagCheck('mintable', 'Mint เพิ่มได้', 'high', g?.mintable, 'GoPlus', renounced),
    flagCheck('hidden_owner', 'มีเจ้าของแฝง', 'high', g?.hiddenOwner, 'GoPlus'),
    flagCheck('take_back_ownership', 'เอาสิทธิ์เจ้าของคืนได้', 'high', x?.takeBackOwnership, 'GoPlus'),
    flagCheck('pausable', 'หยุดการโอนได้', 'high', g?.transferPausable, 'GoPlus'),
    flagCheck('blacklist', 'มี blacklist', 'high', x?.blacklist, 'GoPlus', renounced),
    flagCheck('whitelist', 'มี whitelist', 'medium', x?.whitelist, 'GoPlus', true),
    flagCheck('proxy', 'Contract แก้ไขได้ (proxy/upgradeable)', 'high', proxy === null && hpProxy === null ? null : proxy === true || hpProxy === true, proxy !== null ? 'GoPlus' : 'honeypot.is'),
    flagCheck('closed_source', 'ไม่เปิดเผย source code', 'high', g?.openSource === null || g?.openSource === undefined ? null : !g.openSource, 'GoPlus'),
    flagCheck('self_destruct', 'ทำลาย contract ได้', 'high', x?.selfDestruct, 'GoPlus'),
    flagCheck('external_call', 'เรียก contract ภายนอก', 'medium', x?.externalCall, 'GoPlus', true),
    flagCheck('cooldown', 'จำกัดเวลาซื้อขาย (cooldown)', 'medium', x?.tradingCooldown, 'GoPlus', true),
    flagCheck('creator_honeypot', 'ผู้สร้างเคยทำ honeypot', 'high', x?.honeypotSameCreator, 'GoPlus'),
    percentCheck('top10', 'Top 10 holders ถือรวม', g?.top10HoldersPct, 50, 30, 'GoPlus'),
    percentCheck('creator_pct', 'ผู้สร้าง/เจ้าของถือ', Math.max(g?.creatorPct ?? -1, x?.ownerPct ?? -1) < 0 ? null : Math.max(g?.creatorPct ?? 0, x?.ownerPct ?? 0), 20, 5, 'GoPlus'),
    lpLockCheck(input.poolKind, x?.lpLockedPct),
  ];
}

function solanaChecks(g: SecurityReport | null): SecurityCheck[] {
  const source = g?.authoritySource ?? 'GoPlus';
  const sellTax = g?.sellTaxPct === null || g?.sellTaxPct === undefined
    ? make('sell_tax', 'ภาษีขาย', 'high', 'UNKNOWN', [], 'Token-2022 transfer fee ยังไม่ได้อ่าน')
    : taxCheck('sell_tax', 'ภาษีขาย (Token-2022 transfer fee)', [{ source, pct: g.sellTaxPct }], []);
  return [
    make('honeypot', 'Honeypot (ซื้อแล้วขายไม่ได้)', 'critical', 'UNKNOWN', [], 'ยังไม่มีแหล่งจำลองการซื้อขายฟรีสำหรับ Solana'),
    sellTax,
    flagCheck('mintable', 'Mint authority ยังอยู่', 'high', g?.mintable, source),
    flagCheck('freezable', 'Freeze authority ยังอยู่', 'critical', g?.freezable, source),
    flagCheck('owner_change_balance', 'แก้ยอดเงินได้ (balance mutable / permanent delegate)', 'critical', g?.ownerCanChangeBalance, source),
    flagCheck('pausable', 'Transfer hook บล็อกการโอนได้', 'high', g?.transferPausable, source),
  ];
}

function levelOf(checks: readonly SecurityCheck[]): SecurityLevel {
  const failed = checks.filter((c) => c.status === 'FAIL');
  if (failed.some((c) => c.severity === 'critical')) return 'CRITICAL';
  if (failed.length > 0) return 'HIGH_RISK';
  if (checks.some((c) => CORE.has(c.id) && c.status === 'UNKNOWN')) return 'UNKNOWN';
  if (checks.some((c) => c.status === 'WARN' || c.status === 'UNKNOWN')) return 'CAUTION';
  return 'NO_ISSUES_FOUND';
}

/** Combines GoPlus, honeypot.is and liquidity behaviour into per-check results and one level. */
export function assessSecurity(input: SecurityInput): SecurityAssessment {
  const conflicts: string[] = [];
  const base = input.chain === 'solana' ? solanaChecks(input.goplus) : evmChecks(input, conflicts);
  const drop = input.liquidityFlags.includes('LIQUIDITY_DROP');
  const checks = [...base, make('liquidity_removal', 'สภาพคล่องถูกถอนออก', 'critical', drop ? 'FAIL' : 'PASS', ['on-chain/DexScreener'], drop ? 'ลดลง ≥30% ใน 1 ชม.' : null)];
  const level = levelOf(checks);
  const failed = checks.filter((c) => c.status === 'FAIL');
  const unknownCore = checks.filter((c) => CORE.has(c.id) && c.status === 'UNKNOWN');
  const reasons = [
    ...failed.map((c) => `${c.severity === 'critical' ? '⛔' : '⚠️'} ${c.label}${c.detail ? ` (${c.detail})` : ''}`),
    ...unknownCore.map((c) => `❔ ตรวจไม่ได้: ${c.label}${c.detail ? ` — ${c.detail}` : ''}`),
    ...conflicts.map((c) => `แหล่งข้อมูลขัดกัน: ${c}`),
    ...checks.filter((c) => c.status === 'WARN').map((c) => `ระวัง: ${c.label}${c.detail ? ` (${c.detail})` : ''}`),
  ];
  const otherUnknown = checks.filter((c) => !CORE.has(c.id) && c.status === 'UNKNOWN');
  if (otherUnknown.length > 0) reasons.push(`ตรวจไม่ได้อีก ${otherUnknown.length} รายการ: ${otherUnknown.map((c) => c.label).join(', ')}`);
  if (level === 'NO_ISSUES_FOUND') reasons.push('ไม่พบปัญหาจากแหล่งที่ตอบกลับ (ไม่ได้แปลว่าปลอดภัย)');
  return { level, suppressGemAlert: level === 'CRITICAL', checks, conflicts, reasons };
}

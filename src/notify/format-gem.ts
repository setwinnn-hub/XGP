import type { ChainId } from '../core/types.ts';
import type { GemClass } from '../gem/gem-score.ts';
import type { ScoreRecord } from '../gem/score-store.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';
import { chainBadge, sanitize } from './format.ts';

const FOOTER = 'Meme Coin Radar · Early Gem V2 · คะแนนสูงไม่ได้แปลว่าราคาจะขึ้น · ไม่ใช่คำแนะนำการลงทุน';
const NA = 'ไม่มีข้อมูล';

const baht = (n: number | null | undefined): string => (n === null || n === undefined ? NA : `฿${Math.round(n).toLocaleString('en-US')}`);
const pct = (n: number | null | undefined, signed = true): string => (n === null || n === undefined ? NA : `${signed && n >= 0 ? '+' : ''}${n.toFixed(0)}%`);
const num = (n: number | null | undefined, digits = 0): string => (n === null || n === undefined ? NA : n.toFixed(digits));

export interface GemLinks {
  readonly tokenUrl: string | null;
  readonly explorerUrl: string | null;
}

/** Token page (DexScreener) and block explorer links for an EVM token. */
export function gemLinks(dexscreenerSlug: string | null, explorerTokenUrl: string | null, token: string): GemLinks {
  return {
    tokenUrl: dexscreenerSlug ? `https://dexscreener.com/${dexscreenerSlug}/${token}` : null,
    explorerUrl: explorerTokenUrl ? `${explorerTokenUrl}${token}` : null,
  };
}

function title(r: ScoreRecord): string {
  return sanitize(r.symbol ?? `${r.token.slice(0, 6)}…`, 40);
}

function smartMoney(r: ScoreRecord): string {
  const s = r.snapshot;
  if (!s || s.trackedWallets === 0) return 'ยังไม่มีกระเป๋าที่ติดตามบน chain นี้';
  return s.smartMoneyBuyers60m > 0 ? `👛 ซื้อ ${s.smartMoneyBuyers60m} กระเป๋าใน 1 ชม.` : 'ยังไม่มีกระเป๋าที่ติดตามซื้อ';
}

function bullets(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.slice(0, 5).map((x) => `• ${sanitize(x, 160)}`).join('\n') : empty;
}

/** Status line shown when an alerted token later changes class (the message is edited in place). */
const STATUS_BANNER: Readonly<Record<GemClass, string>> = {
  HIGH_POTENTIAL: '🟢 สถานะปัจจุบัน: HIGH POTENTIAL',
  EARLY_WATCH: '🟡 ลดระดับเป็น EARLY WATCH (ยังเฝ้าต่อ)',
  LOW_ACTIVITY: '⚪ ลดระดับเป็น LOW ACTIVITY (การซื้อขายลดลง)',
  HIGH_RISK: '🟠 ลดระดับเป็น HIGH RISK',
  REJECTED: '🔴 ถูกปฏิเสธ (REJECTED)',
};

/**
 * EARLY GEM DETECTED message (spec Phase 10 layout). The same builder is used to edit the
 * message later, with a banner saying what changed.
 */
export function buildEarlyGemAlert(r: ScoreRecord, links: GemLinks, detectedAt: number): DiscordPayload {
  const s = r.snapshot;
  const mc = r.marketCap;
  const qualified = r.gem.classification === 'HIGH_POTENTIAL';
  const fields: EmbedField[] = [
    { name: 'Chain', value: chainBadge(r.chain as ChainId), inline: true },
    { name: 'Market Cap', value: baht(mc?.circulatingMcapThb), inline: true },
    { name: 'FDV', value: baht(mc?.fdvThb), inline: true },
    { name: 'Liquidity (ขายออกได้)', value: baht(s?.exitLiquidityThb ?? s?.liquidityThb), inline: true },
    { name: 'Volume 5M', value: baht(s?.volume5mThb), inline: true },
    { name: 'Unique Buyers 5M', value: num(s?.uniqueBuyers5m), inline: true },
    { name: 'Unique Buyers Growth', value: pct(s?.uniqueBuyersGrowth5mPct), inline: true },
    { name: 'Buy/Sell Ratio', value: num(s?.buySellRatio15m, 2), inline: true },
    { name: 'Holder Growth', value: NA, inline: true },
    { name: 'Smart Money Activity', value: smartMoney(r), inline: false },
    { name: 'Early Gem Score', value: `**${r.gem.score}**/100`, inline: true },
    { name: 'Data Confidence', value: `${r.gem.confidence}/100`, inline: true },
    { name: 'Risk Level', value: r.gem.classification, inline: true },
    { name: 'Why Detected', value: bullets(s?.whyDetected ?? [], NA), inline: false },
    { name: 'Main Risks', value: bullets(s?.mainRisks ?? [], 'ไม่พบจากแหล่งที่ตรวจได้ (ไม่ได้แปลว่าปลอดภัย)'), inline: false },
    { name: 'Market Cap Verification', value: `${mc?.status ?? 'UNVERIFIED'}${mc?.fx ? ` · ${mc.fx.thbPerUsd.toFixed(2)} THB/USD (${mc.fx.source})` : ''}`, inline: true },
    { name: 'Security Status', value: r.securityLevel, inline: true },
    { name: 'Contract', value: `\`\`\`${r.token}\`\`\``, inline: false },
  ];
  const linkLine = [
    links.tokenUrl ? `[Token](${links.tokenUrl})` : null,
    s?.chartUrl?.startsWith('https://dexscreener.com/') ? `[Chart](${s.chartUrl})` : null,
    links.explorerUrl ? `[Explorer](${links.explorerUrl})` : null,
  ].filter(Boolean).join(' · ');
  const description = [
    qualified ? null : `**${STATUS_BANNER[r.gem.classification]}**${r.gem.gateReasons[0] ? ` — ${sanitize(r.gem.gateReasons[0], 160)}` : ''}`,
    `Detected At: ${new Date(detectedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC · อัปเดต ${new Date(r.at).toISOString().slice(11, 19)} UTC`,
    linkLine,
  ].filter((x): x is string => Boolean(x)).join('\n');
  return {
    embeds: [{
      title: `${qualified ? '🚀 EARLY GEM DETECTED' : '📉 EARLY GEM (สถานะเปลี่ยน)'}: ${title(r)}`,
      ...(s?.chartUrl?.startsWith('https://dexscreener.com/') ? { url: s.chartUrl } : {}),
      description,
      color: qualified ? 0x22c55e : r.gem.classification === 'REJECTED' ? 0xdc2626 : 0xf59e0b,
      fields,
      timestamp: new Date(r.at).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

/** Separate HIGH RISK alert for a watchlisted token that turned dangerous (never mixed with gem alerts). */
export function buildGemRiskAlert(r: ScoreRecord, links: GemLinks, from: GemClass | null): DiscordPayload {
  const reasons = [...r.gem.gateReasons, ...(r.snapshot?.mainRisks ?? [])];
  return {
    embeds: [{
      title: `🚨 GEM RISK: ${title(r)}`,
      description: [
        `${chainBadge(r.chain as ChainId)} · เคยอยู่ใน watchlist (${from ?? '-'}) → **${r.gem.classification}**`,
        '',
        bullets([...new Set(reasons)], 'ตรวจพบความเสี่ยงระดับวิกฤต'),
        '',
        links.explorerUrl ? `[Explorer](${links.explorerUrl})` : '',
      ].join('\n').trim(),
      color: 0xdc2626,
      fields: [
        { name: 'Security Status', value: r.securityLevel, inline: true },
        { name: 'Liquidity', value: r.liquidity, inline: true },
        { name: 'Contract', value: `\`\`\`${r.token}\`\`\``, inline: false },
      ],
      timestamp: new Date(r.at).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

import type { RadarEvent } from '../core/types.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';
import { caBlock, chainBadge, footer, linkRow, sanitize, tokenTitle } from './format.ts';
import { usd as formatUsd } from '../analysis/score.ts';

const RISK_LABEL: Readonly<Record<string, string>> = { LOW: '🟢 ต่ำ', MEDIUM: '🟡 ปานกลาง', HIGH: '🟠 สูง', CRITICAL: '🔴 วิกฤต' };
const MAX_REASONS = 6;

function list(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function usd(value: unknown): string {
  if (typeof value !== 'number') return '-';
  return value >= 1 ? formatUsd(value) : `$${value.toPrecision(3)}`;
}

function bar(score: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return `${'🟩'.repeat(filled)}${'⬛'.repeat(10 - filled)}  **${score}**/100`;
}

function pct(value: unknown): string {
  return typeof value === 'number' ? `${value >= 0 ? '🟢 +' : '🔴 '}${value.toFixed(1)}%` : '-';
}

/** Risk text without its "[LEVEL]" prefix (the level is shown once, above). */
function plain(reason: string): string {
  return reason.replace(/^\[(LOW|MEDIUM|HIGH|CRITICAL)\]\s*/, '');
}

/** Embed for HIGH_OPPORTUNITY and HIGH_RISK alerts. */
export function buildAnalysisAlert(event: RadarEvent): DiscordPayload {
  const d = event.details;
  const opportunity = typeof d.opportunity === 'number' ? d.opportunity : 0;
  const isRisk = d.alert === 'risk';
  const name = tokenTitle(event) ?? `${event.tokenAddress.slice(0, 6)}…`;
  const positives = list(d.positives).slice(0, MAX_REASONS).map((p) => `✅ ${sanitize(p, 120)}`);
  const risks = list(d.risks).slice(0, MAX_REASONS).map((r) => `⚠️ ${sanitize(plain(r), 120)}`);
  const smart = typeof d.smartBuyers === 'number' && d.smartBuyers > 0 ? ` · 👛 wallet ที่ติดตามซื้อ ${d.smartBuyers} ตัว` : '';
  const chart = event.txHash.startsWith('https://') ? [{ label: 'DexScreener', url: event.txHash }] : [];
  const description = [
    bar(opportunity),
    `🛡️ ความเสี่ยง **${RISK_LABEL[String(d.risk)] ?? String(d.risk)}**${smart}`,
    '',
    isRisk || risks.length > 0 ? `**${isRisk ? 'ทำไมถึงเสี่ยง' : 'ข้อควรระวัง'}**\n${risks.join('\n') || 'ไม่พบจากข้อมูลที่ตรวจได้'}` : '',
    positives.length > 0 ? `**สัญญาณบวก**\n${positives.join('\n')}` : '',
    caBlock(event.tokenAddress),
    linkRow(chart),
  ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n').trim();
  const fields: EmbedField[] = [
    { name: '📊 Market Cap', value: usd(d.marketCapUsd), inline: true },
    { name: '💧 สภาพคล่อง', value: usd(d.liquidityUsd), inline: true },
    { name: '📈 Vol 1 ชม.', value: usd(d.volumeH1Usd), inline: true },
    { name: '🔁 ซื้อ / ขาย 1 ชม.', value: `${String(d.buysH1 ?? '-')} / ${String(d.sellsH1 ?? '-')}`, inline: true },
    { name: '⏱️ ราคา 1 ชม.', value: pct(d.changeH1Pct), inline: true },
    { name: '​', value: '​', inline: true },
  ];
  const image = typeof d.image === 'string' && d.image.startsWith('https://') ? d.image : null;
  return {
    embeds: [{
      author: { name: `${isRisk ? '🚨 HIGH RISK' : '💎 HIGH OPPORTUNITY'} · ${chainBadge(event.chain)}` },
      title: isRisk ? `🚨 HIGH RISK: ${name}` : `💎 ${name}`,
      ...(chart[0] ? { url: chart[0].url } : {}),
      description: description.slice(0, 4000),
      color: isRisk ? 0xdc2626 : 0x10b981,
      fields,
      ...(image ? { thumbnail: { url: image } } : {}),
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: footer('คะแนนจากกฎที่ตรวจสอบได้ ไม่ใช่การทำนายราคา'),
    }],
  };
}

import type { RadarEvent } from '../core/types.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';
import { chainBadge, sanitize, tokenTitle } from './format.ts';
import { usd as formatUsd } from '../analysis/score.ts';

const FOOTER = 'Meme Coin Radar · คะแนนจากกฎที่ตรวจสอบได้ ไม่ใช่การทำนายราคา · ไม่ใช่คำแนะนำการลงทุน';
const RISK_LABEL: Readonly<Record<string, string>> = { LOW: '🟢 ต่ำ', MEDIUM: '🟡 ปานกลาง', HIGH: '🟠 สูง', CRITICAL: '🔴 วิกฤต' };

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
  const filled = Math.round(score / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} **${score}**/100`;
}

/** Embed for HIGH_OPPORTUNITY and HIGH_RISK alerts. */
export function buildAnalysisAlert(event: RadarEvent): DiscordPayload {
  const d = event.details;
  const opportunity = typeof d.opportunity === 'number' ? d.opportunity : 0;
  const isRisk = d.alert === 'risk';
  const name = tokenTitle(event) ?? `${event.tokenAddress.slice(0, 6)}…`;
  const positives = list(d.positives).map((p) => `✅ ${sanitize(p, 150)}`);
  const risks = list(d.risks).map((r) => `⚠️ ${sanitize(r, 150)}`);
  const change = typeof d.changeH1Pct === 'number' ? `${d.changeH1Pct >= 0 ? '+' : ''}${d.changeH1Pct.toFixed(1)}%` : '-';
  const fields: EmbedField[] = [
    { name: '🎯 คะแนนโอกาส', value: bar(opportunity), inline: false },
    { name: '🛡️ ระดับความเสี่ยง', value: RISK_LABEL[String(d.risk)] ?? String(d.risk), inline: true },
    { name: '💧 สภาพคล่อง', value: usd(d.liquidityUsd), inline: true },
    { name: '📊 Market Cap', value: usd(d.marketCapUsd), inline: true },
    { name: '📈 Volume 1 ชม.', value: usd(d.volumeH1Usd), inline: true },
    { name: '🔁 ซื้อ/ขาย 1 ชม.', value: `${String(d.buysH1 ?? '-')} / ${String(d.sellsH1 ?? '-')}`, inline: true },
    { name: '⏱️ ราคา 1 ชม.', value: change, inline: true },
    { name: '📋 Contract Address', value: `\`\`\`${event.tokenAddress}\`\`\``, inline: false },
  ];
  const description = [
    `${chainBadge(event.chain)}${typeof d.smartBuyers === 'number' && d.smartBuyers > 0 ? ` · 👛 wallet ที่ติดตามซื้อ ${d.smartBuyers} ตัว` : ''}`,
    '',
    risks.length > 0 ? `**ความเสี่ยงที่พบ**\n${risks.slice(0, 8).join('\n')}` : '**ความเสี่ยงที่พบ**\nไม่พบความเสี่ยงจากข้อมูลที่ตรวจได้',
    '',
    positives.length > 0 ? `**สัญญาณบวก**\n${positives.slice(0, 8).join('\n')}` : '',
  ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n').trim();
  const image = typeof d.image === 'string' && d.image.startsWith('https://') ? d.image : null;
  return {
    embeds: [{
      title: isRisk ? `🚨 HIGH RISK: ${name}` : `💎 HIGH OPPORTUNITY: ${name}`,
      ...(event.txHash.startsWith('https://') ? { url: event.txHash } : {}),
      description: description.slice(0, 4000),
      color: isRisk ? 0xdc2626 : 0x10b981,
      fields,
      ...(image ? { thumbnail: { url: image } } : {}),
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

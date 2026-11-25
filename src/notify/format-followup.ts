import type { ChainId } from '../core/types.ts';
import type { DiscordPayload } from './discord-client.ts';
import { CHAIN_SLUG, footer, money, sanitize } from './format.ts';

export interface FollowUp {
  readonly chain: ChainId;
  readonly token: string;
  readonly symbol: string | null;
  readonly hours: number;
  readonly fromUsd: number;
  readonly toUsd: number;
  readonly changePct: number;
}

export interface SummaryRow {
  readonly chain: ChainId;
  readonly token: string;
  readonly symbol: string | null;
  readonly score: number | null;
  /** Change from the alert price to now; null when no price was available. */
  readonly changePct: number | null;
}

const MAX_LINES = 15;

function pct(n: number): string {
  return `${n >= 0 ? '🟢 +' : '🔴 '}${n.toFixed(1)}%`;
}

function price(n: number): string {
  return n >= 1 ? money(n) : `$${n.toPrecision(3)}`;
}

function tokenLink(chain: ChainId, token: string, symbol: string | null): string {
  const name = symbol ? `$${sanitize(symbol, 16)}` : `${token.slice(0, 6)}…`;
  const slug = CHAIN_SLUG[chain];
  return slug ? `[${name}](https://dexscreener.com/${slug}/${token})` : name;
}

/** One message for every follow-up that came due in the same check. */
export function buildFollowUps(items: readonly FollowUp[], at: number): DiscordPayload {
  const lines = items.slice(0, MAX_LINES).map((f) =>
    `**${tokenLink(f.chain, f.token, f.symbol)}** หลัง ${f.hours} ชม. · ${pct(f.changePct)}  (${price(f.fromUsd)} → ${price(f.toUsd)})`);
  const best = Math.max(...items.map((f) => f.changePct));
  return {
    embeds: [{
      author: { name: '📊 ผลติดตามแจ้งเตือน' },
      title: items.length === 1 ? 'ราคาหลังแจ้งเตือน' : `ราคาหลังแจ้งเตือน (${items.length} ตัว)`,
      description: [...lines, items.length > MAX_LINES ? `…และอีก ${items.length - MAX_LINES} ตัว` : ''].filter(Boolean).join('\n'),
      color: best >= 0 ? 0x22c55e : 0xef4444,
      fields: [],
      timestamp: new Date(at).toISOString(),
      footer: footer('ผลย้อนหลังไม่ได้รับประกันอนาคต'),
    }],
  };
}

/** 09:00 summary of the last 24 hours of opportunity alerts. */
export function buildDailySummary(rows: readonly SummaryRow[], day: string, at: number): DiscordPayload {
  const known = rows.filter((r): r is SummaryRow & { changePct: number } => r.changePct !== null);
  const wins = known.filter((r) => r.changePct > 0).length;
  const avg = known.length > 0 ? known.reduce((s, r) => s + r.changePct, 0) / known.length : null;
  const sorted = [...known].sort((a, b) => b.changePct - a.changePct);
  const stats = rows.length === 0
    ? 'ไม่มีแจ้งเตือน HIGH OPPORTUNITY ใน 24 ชม. ที่ผ่านมา'
    : [
        `แจ้งเตือน **${rows.length} ตัว** · ขึ้น **${wins}/${known.length}** ตัว${avg !== null ? ` · เฉลี่ย ${pct(avg)}` : ''}`,
        sorted[0] ? `🏆 ดีที่สุด ${tokenLink(sorted[0].chain, sorted[0].token, sorted[0].symbol)} ${pct(sorted[0].changePct)}` : '',
        sorted.length > 1 ? `📉 แย่ที่สุด ${tokenLink(sorted.at(-1)!.chain, sorted.at(-1)!.token, sorted.at(-1)!.symbol)} ${pct(sorted.at(-1)!.changePct)}` : '',
      ].filter(Boolean).join('\n');
  const list = sorted.slice(0, MAX_LINES).map((r, i) => `${i + 1}. ${tokenLink(r.chain, r.token, r.symbol)} · คะแนน ${r.score ?? '-'} · ${pct(r.changePct)}`);
  return {
    embeds: [{
      author: { name: '🗓️ สรุปประจำวัน' },
      title: `สรุปผลแจ้งเตือน ${day}`,
      description: [stats, list.length > 0 ? `\n**ราคาตอนนี้เทียบกับตอนแจ้ง**\n${list.join('\n')}` : ''].filter(Boolean).join('\n'),
      color: avg === null ? 0x64748b : avg >= 0 ? 0x22c55e : 0xef4444,
      fields: [],
      timestamp: new Date(at).toISOString(),
      footer: footer('ผลย้อนหลังไม่ได้รับประกันอนาคต'),
    }],
  };
}

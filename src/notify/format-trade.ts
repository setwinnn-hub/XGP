import type { RadarEvent } from '../core/types.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';
import { chainBadge, sanitize, tokenTitle } from './format.ts';

const GREEN = 0x22c55e;
const RED = 0xef4444;
const FOOTER = 'Meme Coin Radar · ติดตาม wallet สาธารณะ · ไม่ใช่คำแนะนำการลงทุน';

export interface TradeAlertContext {
  /** Earlier trades of the same side by this wallet in this token. */
  readonly priorSameSide: number;
  readonly isWhale: boolean;
}

function amount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (value >= 1_000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function repeatText(side: string, prior: number): string {
  const verb = side === 'BUY' ? 'ซื้อ' : 'ขาย';
  return prior === 0 ? `${verb}ครั้งแรก` : `🔁 ${verb}ซ้ำ (ครั้งที่ ${prior + 1})`;
}

function valueText(event: RadarEvent): string {
  const d = event.details;
  const quote = `${amount(Number(d.quoteAmount))} ${String(d.quoteSymbol)}`;
  if (typeof d.usdValue !== 'number') return `${quote}\n(ไม่มีราคา USD)`;
  return `**$${d.usdValue.toLocaleString('en-US', { maximumFractionDigits: d.usdValue >= 100 ? 0 : 2 })}**\n${quote}`;
}

/** Embed for SMART MONEY BUY / SELL. */
export function buildTradeAlert(event: RadarEvent, context: TradeAlertContext): DiscordPayload {
  const d = event.details;
  const buy = d.side === 'BUY';
  const wallet = String(d.wallet);
  const who = typeof d.walletLabel === 'string' ? sanitize(d.walletLabel, 40) || shortAddress(wallet) : shortAddress(wallet);
  const token = tokenTitle(event) ?? shortAddress(event.tokenAddress);
  const unix = Math.floor(event.detectedAt / 1000);
  const venue = typeof d.venue === 'string' ? ` บน **${sanitize(d.venue, 24)}**` : '';
  const title = `${context.isWhale ? '🐋 ' : ''}${buy ? '🟢 BUY' : '🔴 SELL'}  ${token}`;
  const description = [
    `👤 **${who}** ${buy ? 'ซื้อ' : 'ขาย'}${venue} · ${chainBadge(event.chain)}`,
    `⏱️ ตรวจพบ <t:${unix}:T> (<t:${unix}:R>)`,
  ].join('\n');
  const symbol = event.tokenSymbol ? sanitize(event.tokenSymbol, 16) : 'tokens';
  const fields: EmbedField[] = [
    { name: '💵 มูลค่า', value: valueText(event), inline: true },
    { name: '🪙 จำนวน', value: `${amount(Number(d.tokenAmount))} ${symbol || 'tokens'}`, inline: true },
    { name: '📈 ประวัติ', value: repeatText(String(d.side), context.priorSameSide), inline: true },
    { name: '📋 Contract Address', value: `\`\`\`${event.tokenAddress}\`\`\``, inline: false },
    { name: '👛 Wallet', value: `\`${wallet}\``, inline: false },
    { name: '🔗 เปิดดู', value: event.links.map((l) => `[${l.label}](${l.url})`).join('  •  '), inline: false },
  ];
  return {
    embeds: [{
      title: title.slice(0, 256),
      url: event.links[1]?.url,
      description,
      color: buy ? GREEN : RED,
      fields,
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

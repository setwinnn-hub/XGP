import type { RadarEvent } from '../core/types.ts';
import type { DiscordPayload } from './discord-client.ts';
import { caBlock, chainBadge, footer, linkRow, money, sanitize, shortAddress, tokenTitle } from './format.ts';

const GREEN = 0x22c55e;
const RED = 0xef4444;

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

function repeatText(side: string, prior: number): string {
  const verb = side === 'BUY' ? 'ซื้อ' : 'ขาย';
  return prior === 0 ? `✨ ${verb}ครั้งแรก` : `🔁 ${verb}ซ้ำ ครั้งที่ ${prior + 1}`;
}

/**
 * Embed for SMART MONEY BUY / SELL. The title carries what matters most (side, token, USD),
 * the body reads as one sentence, then the copyable contract address and links.
 */
export function buildTradeAlert(event: RadarEvent, context: TradeAlertContext): DiscordPayload {
  const d = event.details;
  const buy = d.side === 'BUY';
  const wallet = String(d.wallet);
  const who = typeof d.walletLabel === 'string' ? sanitize(d.walletLabel, 40) || shortAddress(wallet) : shortAddress(wallet);
  const symbol = event.tokenSymbol ? sanitize(event.tokenSymbol, 16) : '';
  const token = symbol ? `$${symbol}` : (tokenTitle(event) ?? shortAddress(event.tokenAddress));
  const usdValue = typeof d.usdValue === 'number' ? d.usdValue : null;
  const unix = Math.floor(event.detectedAt / 1000);
  const venue = typeof d.venue === 'string' ? ` บน ${sanitize(d.venue, 24)}` : '';
  const quote = `${amount(Number(d.quoteAmount))} ${sanitize(String(d.quoteSymbol), 12)}`;
  const name = event.tokenName && symbol && event.tokenName.toLowerCase() !== symbol.toLowerCase() ? ` · ${sanitize(event.tokenName, 40)}` : '';
  const title = `${context.isWhale ? '🐋 ' : ''}${buy ? '🟢 BUY' : '🔴 SELL'} ${token}${usdValue !== null ? ` · ${money(usdValue)}` : ''}`;
  const description = [
    `**${who}** ${buy ? 'ซื้อ' : 'ขาย'} **${amount(Number(d.tokenAmount))} ${symbol || 'tokens'}**${name}`,
    `💵 ${usdValue !== null ? `**${money(usdValue)}**` : '(ไม่มีราคา USD)'} · ${quote}${venue}`,
    `${repeatText(String(d.side), context.priorSameSide)} · ⏱️ <t:${unix}:R>`,
    caBlock(event.tokenAddress),
    linkRow(event.links),
  ].join('\n');
  return {
    embeds: [{
      author: { name: `${buy ? 'SMART MONEY BUY' : 'SMART MONEY SELL'} · ${chainBadge(event.chain)}` },
      title: title.slice(0, 256),
      url: event.links[0]?.url,
      description,
      color: buy ? GREEN : RED,
      fields: [],
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: footer(`wallet ${shortAddress(wallet)}`),
    }],
  };
}

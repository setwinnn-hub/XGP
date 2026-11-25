import type { RadarEvent } from '../core/types.ts';
import type { CardData } from './card.ts';
import { chainLabel, money, shortAddress } from './format.ts';

const RISK_TH: Readonly<Record<string, string>> = { LOW: 'ความเสี่ยง ต่ำ', MEDIUM: 'ความเสี่ยง กลาง', HIGH: 'ความเสี่ยง สูง', CRITICAL: 'ความเสี่ยง วิกฤต' };
const VENUES: Readonly<Record<string, string>> = { 'pump-amm': 'PumpSwap', raydium: 'Raydium' };

/**
 * "01:13" in the given time zone; default is this machine's, which is what Discord shows the
 * user when they read alerts on it.
 */
export function clockTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(ms);
}

function amount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

function usdOrDash(value: unknown): string {
  return typeof value === 'number' ? (value >= 1 ? money(value) : `$${value.toPrecision(3)}`) : '-';
}

function title(event: RadarEvent): { title: string; subtitle?: string } {
  const symbol = event.tokenSymbol?.trim();
  const name = event.tokenName?.trim();
  if (symbol) return { title: `$${symbol}`, ...(name && name.toLowerCase() !== symbol.toLowerCase() ? { subtitle: name } : {}) };
  return { title: name || shortAddress(event.tokenAddress) };
}

/** Card for a new token, a Pump.fun graduation or a new EVM pair. */
export function tokenCard(event: RadarEvent): CardData {
  const d = event.details;
  const chain = chainLabel(event.chain).toUpperCase();
  const platform = String(d.platform ?? event.source);
  const stats = [
    ...(typeof d.devBuySol === 'number' ? [{ label: 'Dev ซื้อเอง', value: `${amount(d.devBuySol)} SOL` }] : []),
    ...(typeof d.marketCapSol === 'number' ? [{ label: 'Market Cap', value: `${amount(d.marketCapSol)} SOL` }] : []),
    ...(typeof d.quoteSymbol === 'string' ? [{ label: 'จับคู่กับ', value: d.quoteSymbol }] : []),
    { label: 'ตรวจพบ', value: clockTime(event.detectedAt) },
  ].slice(0, 3);
  if (event.kind === 'token_migrated') {
    const venue = typeof d.migratedTo === 'string' ? (VENUES[d.migratedTo] ?? d.migratedTo) : 'DEX';
    return { badge: `GRADUATED · ${chain}`, accent: 'green', ...title(event), address: event.tokenAddress, stats, side: { top: 'จบ Curve', big: 'DEX', bottom: venue } };
  }
  if (event.kind === 'pair_created') {
    return { badge: `NEW PAIR · ${chain}`, accent: 'blue', ...title(event), address: event.tokenAddress, stats, side: { top: 'คู่เทรดใหม่', big: 'NEW', bottom: platform } };
  }
  return { badge: `NEW TOKEN · ${chain} · ${platform.toUpperCase()}`, accent: 'gold', ...title(event), address: event.tokenAddress, stats, side: { top: 'เหรียญใหม่', big: 'NEW', bottom: platform } };
}

/** Card for a followed-wallet BUY or SELL: the USD value is the big number. */
export function tradeCard(event: RadarEvent, ctx: { readonly priorSameSide: number; readonly isWhale: boolean }): CardData {
  const d = event.details;
  const buy = d.side === 'BUY';
  const usd = typeof d.usdValue === 'number' ? d.usdValue : null;
  const who = typeof d.walletLabel === 'string' && d.walletLabel.trim() ? d.walletLabel : shortAddress(String(d.wallet));
  return {
    badge: `${ctx.isWhale ? 'WHALE ' : ''}SMART MONEY ${buy ? 'BUY' : 'SELL'} · ${chainLabel(event.chain).toUpperCase()}`,
    accent: buy ? 'green' : 'red',
    ...title(event),
    address: event.tokenAddress,
    stats: [
      { label: 'จำนวน', value: amount(Number(d.tokenAmount)) },
      { label: buy ? 'จ่าย' : 'ได้รับ', value: `${amount(Number(d.quoteAmount))} ${String(d.quoteSymbol)}` },
      { label: buy ? 'ซื้อครั้งที่' : 'ขายครั้งที่', value: String(ctx.priorSameSide + 1) },
    ],
    side: { top: buy ? 'ซื้อ' : 'ขาย', big: usd !== null ? money(usd) : '?', bottom: who },
  };
}

/** Card for HIGH OPPORTUNITY / HIGH RISK: the score is the big number. */
export function analysisCard(event: RadarEvent): CardData {
  const d = event.details;
  const risk = d.alert === 'risk';
  const score = typeof d.opportunity === 'number' ? d.opportunity : 0;
  return {
    badge: `${risk ? 'HIGH RISK' : 'HIGH OPPORTUNITY'} · ${chainLabel(event.chain).toUpperCase()}`,
    accent: risk ? 'red' : score >= 70 ? 'green' : 'gold',
    ...title(event),
    address: event.tokenAddress,
    stats: [
      { label: 'Market Cap', value: usdOrDash(d.marketCapUsd) },
      { label: 'สภาพคล่องจริง', value: usdOrDash(d.liquidityUsd) },
      typeof d.holderCount === 'number'
        ? { label: 'ผู้ถือ', value: amount(d.holderCount) }
        : { label: 'Vol 1 ชม.', value: usdOrDash(d.volumeH1Usd) },
    ],
    side: { top: 'คะแนน', big: String(score), bottom: RISK_TH[String(d.risk)] ?? String(d.risk) },
  };
}

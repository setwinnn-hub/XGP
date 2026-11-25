import { EVM_CHAINS } from '../chains/evm/chains.ts';
import type { ChainId, RadarEvent } from '../core/types.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';

const COLORS = { launch: 0xff7a00, migrate: 0x2ecc71, pair: 0x3498db, systemOk: 0x2ecc71, systemBad: 0xe74c3c } as const;
const MAX_NAME = 64;

const CHAIN_BADGE: Readonly<Record<string, string>> = {
  solana: '🟣',
  ethereum: '🔷',
  base: '🔵',
  bsc: '🟡',
};

/** Friendly names for raw venue ids coming from data sources. */
const VENUE_NAMES: Readonly<Record<string, string>> = {
  'pump-amm': 'PumpSwap',
  raydium: 'Raydium',
};

/** Control, zero-width and bidi-override characters (written as escapes on purpose). */
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g');
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** Token names/symbols are chosen by anyone who launches a token: strip markdown, links and mentions. */
export function sanitize(text: string, max: number = MAX_NAME): string {
  const cleaned = text
    .replace(INVISIBLE, '')
    .replace(/[\\`*_~|>#[\]()<]/g, '')
    .replace(/@/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/https?:\/\//gi, '')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** sanitize() for embed text, which Discord rejects when empty. */
function safeText(text: string, max: number = MAX_NAME): string {
  return sanitize(text, max) || '-';
}

export function chainLabel(chain: ChainId): string {
  if (chain === 'solana') return 'Solana';
  if (chain === 'offchain') return 'ข่าว/โซเชียล';
  return EVM_CHAINS.find((c) => c.id === chain)?.label ?? chain;
}

export function chainBadge(chain: ChainId): string {
  return `${CHAIN_BADGE[chain] ?? '⛓️'} ${chainLabel(chain)}`;
}

/** "$SYMBOL · Name", or null when the token has no readable name yet. */
export function tokenTitle(event: RadarEvent): string | null {
  const symbol = event.tokenSymbol ? sanitize(event.tokenSymbol, 24) : '';
  const name = event.tokenName ? sanitize(event.tokenName) : '';
  if (symbol && name && symbol.toLowerCase() !== name.toLowerCase()) return `$${symbol} · ${name}`;
  if (symbol) return `$${symbol}`;
  return name || null;
}

export const BRAND = 'Meme Coin Radar';
const NOT_ADVICE = 'ไม่ใช่คำแนะนำการลงทุน';

/** Short footer shared by every alert. */
export function footer(note?: string): { text: string } {
  return { text: [BRAND, note, NOT_ADVICE].filter(Boolean).join(' · ') };
}

/** "0xa6ee…5e52": enough to recognise an address at a glance. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The contract address as a code block: one tap/long-press to copy on desktop and mobile. */
export function caBlock(address: string): string {
  return `\`\`\`${address}\`\`\``;
}

const LINK_LABELS: Readonly<Record<string, string>> = {
  DexScreener: '📊 Chart', Transaction: '🧾 Tx', Wallet: '👛 Wallet', GeckoTerminal: '🦎 GeckoTerminal',
  'Pump.fun': '💊 Pump.fun', CoinGecko: '🦎 CoinGecko',
};

/** One line of links: "📊 Chart · 🧾 Tx · 👛 Wallet". */
export function linkRow(links: readonly { readonly label: string; readonly url: string }[]): string {
  return links
    .filter((l) => l.url.startsWith('https://'))
    .map((l) => `[${LINK_LABELS[l.label] ?? `🔗 ${sanitize(l.label, 24)}`}](${l.url})`)
    .join('  ·  ');
}

/** Compact money: $993, $12.4k, $1.26M. */
export function money(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

function formatAmount(value: number, digits: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

interface Headline {
  readonly icon: string;
  readonly label: string;
  readonly what: string;
  readonly color: number;
}

function headlineFor(event: RadarEvent): Headline {
  const platform = safeText(String(event.details.platform ?? event.source));
  if (event.kind === 'token_launched') return { icon: '🔥', label: 'NEW TOKEN', what: `เปิดตัวใหม่บน **${platform}**`, color: COLORS.launch };
  if (event.kind === 'token_migrated') {
    const raw = typeof event.details.migratedTo === 'string' ? event.details.migratedTo : '';
    const venue = VENUE_NAMES[raw] ?? (safeText(raw) === '-' ? 'DEX' : safeText(raw));
    return { icon: '🎓', label: 'GRADUATED', what: `จบ Bonding Curve ย้ายไปเทรดบน **${venue}**`, color: COLORS.migrate };
  }
  return { icon: '💧', label: 'NEW PAIR', what: `คู่เทรดใหม่บน **${platform}**`, color: COLORS.pair };
}

function statFields(event: RadarEvent): EmbedField[] {
  const d = event.details;
  return [
    ...(typeof d.devBuySol === 'number' ? [{ name: '💰 Dev ซื้อเอง', value: `${formatAmount(d.devBuySol, 2)} SOL`, inline: true }] : []),
    ...(typeof d.marketCapSol === 'number' ? [{ name: '📊 Market Cap', value: `${formatAmount(d.marketCapSol, 1)} SOL`, inline: true }] : []),
    ...(typeof d.quoteSymbol === 'string' ? [{ name: '🔁 จับคู่กับ', value: safeText(d.quoteSymbol, 16), inline: true }] : []),
  ];
}

/** Embed for NEW TOKEN ALERT (Pump.fun launch, Pump.fun migration, new EVM pair). */
export function buildTokenAlert(event: RadarEvent): DiscordPayload {
  const { icon, label, what, color } = headlineFor(event);
  const name = tokenTitle(event);
  const unix = Math.floor(event.detectedAt / 1000);
  const links = linkRow(event.links);
  const description = [
    `${what} · ⏱️ <t:${unix}:R>`,
    caBlock(event.tokenAddress),
    links,
  ].filter(Boolean).join('\n');
  return {
    embeds: [{
      author: { name: `${label} · ${chainBadge(event.chain)}` },
      title: `${icon} ${name ?? 'ยังไม่ทราบชื่อเหรียญ'}`,
      url: event.links[0]?.url,
      description,
      color,
      fields: statFields(event),
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: footer(),
    }],
  };
}

export function buildSystemAlert(text: string, ok: boolean): DiscordPayload {
  return {
    embeds: [{
      title: ok ? '✅ ระบบทำงานปกติ' : '⚠️ ระบบมีปัญหา',
      description: text.slice(0, 2000),
      color: ok ? COLORS.systemOk : COLORS.systemBad,
      fields: [],
      timestamp: new Date().toISOString(),
    }],
  };
}

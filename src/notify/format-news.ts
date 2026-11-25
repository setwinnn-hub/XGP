import type { RadarEvent } from '../core/types.ts';
import { explainSignals, type NewsSignals, type NewsTag } from '../news/extract.ts';
import type { DiscordPayload, EmbedField } from './discord-client.ts';
import { sanitize } from './format.ts';

const FOOTER = 'Meme Coin Radar · News · ไม่ใช่คำแนะนำการลงทุน';
const TAG_LABELS: Readonly<Record<NewsTag, string>> = {
  LISTING: '📈 Listing', LAUNCH: '🚀 เปิดตัว', PARTNERSHIP: '🤝 ความร่วมมือ', WHALE: '🐋 Whale',
  HACK_RUG: '🚨 แฮ็ก/Rug', AIRDROP: '🎁 Airdrop', REGULATION: '⚖️ กฎหมาย',
};

function csv(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? value.split(',') : [];
}

/** Signals stored on a news event, read back for formatting. */
export function signalsOf(event: RadarEvent): NewsSignals {
  const d = event.details;
  return {
    tickers: csv(d.tickers),
    addresses: csv(d.addresses),
    tags: csv(d.tags) as NewsTag[],
    memeNames: csv(d.memeNames),
    memeRelated: d.memeRelated === true,
  };
}

function colorFor(tags: readonly NewsTag[]): number {
  if (tags.includes('HACK_RUG')) return 0xef4444;
  if (tags.includes('LISTING')) return 0xf59e0b;
  return 0x8b5cf6;
}

/** Embed for BREAKING NEWS: readable in Discord without opening the link. */
export function buildNewsAlert(event: RadarEvent, image: string | null): DiscordPayload {
  const d = event.details;
  const signals = signalsOf(event);
  const reasons = explainSignals(signals);
  const published = typeof d.published === 'number' ? Math.floor(d.published / 1000) : null;
  const detected = Math.floor(event.detectedAt / 1000);
  const source = [sanitize(String(d.feed ?? ''), 40), typeof d.author === 'string' ? sanitize(d.author, 60) : ''].filter(Boolean).join(' · ');
  const summary = typeof d.summary === 'string' && d.summary ? sanitize(d.summary, 700) : '';
  const description = [
    summary,
    reasons.length > 0 ? `\n**💡 ทำไมข่าวนี้สำคัญ**\n${reasons.map((r) => `• ${r}`).join('\n')}` : '',
  ].filter(Boolean).join('\n') || 'ไม่มีเนื้อหาย่อจากแหล่งข่าว';
  const coins = [...new Set([...signals.tickers, ...signals.memeNames])];
  const fields: EmbedField[] = [
    { name: '📰 แหล่งข่าว', value: source || '-', inline: true },
    { name: '⏱️ เวลา', value: published ? `เผยแพร่ <t:${published}:R>\nตรวจพบ <t:${detected}:T>` : `ตรวจพบ <t:${detected}:T>`, inline: true },
    ...(coins.length > 0 ? [{ name: '🪙 เหรียญ', value: coins.slice(0, 8).map((c) => `$${sanitize(c, 12)}`).join(' '), inline: true }] : []),
    ...(signals.tags.length > 0 ? [{ name: '🏷️ ประเภทข่าว', value: signals.tags.map((t) => TAG_LABELS[t]).join('  '), inline: false }] : []),
    ...(signals.addresses.length > 0 ? [{ name: '📋 Contract Address', value: signals.addresses.slice(0, 3).map((a) => `\`${a}\``).join('\n'), inline: false }] : []),
  ];
  return {
    embeds: [{
      title: `⚡ ${sanitize(String(d.title ?? 'ข่าว'), 240)}`,
      url: event.txHash,
      description,
      color: colorFor(signals.tags),
      fields,
      ...(image ? { image: { url: image } } : {}),
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

interface Example { readonly title: string; readonly link: string; readonly source: string }

function parseExamples(value: unknown): Example[] {
  try {
    const parsed: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(parsed) ? (parsed as Example[]).filter((e) => typeof e.link === 'string' && e.link.startsWith('https://')) : [];
  } catch {
    return [];
  }
}

function mentionsTrend(event: RadarEvent): DiscordPayload {
  const d = event.details;
  const symbol = sanitize(event.tokenSymbol ?? '?', 16);
  const examples = parseExamples(d.examples);
  return {
    embeds: [{
      title: `📈 TRENDING: $${symbol} ถูกพูดถึงพร้อมกันหลายสำนัก`,
      description: [
        `**$${symbol}** ถูกกล่าวถึง **${Number(d.mentions)} ครั้ง** ใน ${Number(d.windowMin)} นาที จาก ${sanitize(String(d.sources), 200)}`,
        '',
        '**หัวข่าวล่าสุด**',
        ...examples.map((e) => `• [${sanitize(e.title, 150)}](${e.link}) — ${sanitize(e.source, 30)}`),
      ].join('\n'),
      color: 0x06b6d4,
      fields: [],
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

function coingeckoTrend(event: RadarEvent): DiscordPayload {
  const d = event.details;
  const change = typeof d.change24hPct === 'number' ? `${d.change24hPct >= 0 ? '🟢 +' : '🔴 '}${d.change24hPct.toFixed(1)}%` : 'ไม่มีข้อมูล';
  const image = typeof d.image === 'string' && d.image.startsWith('https://') ? d.image : null;
  return {
    embeds: [{
      title: `🔥 ติด Trending บน CoinGecko: $${sanitize(event.tokenSymbol ?? '?', 16)} · ${sanitize(event.tokenName ?? '', 60)}`,
      url: event.txHash,
      description: 'เหรียญนี้เพิ่งเข้าอันดับ "ถูกค้นหามากที่สุด" ของ CoinGecko ซึ่งเป็นสัญญาณว่าคนเริ่มสนใจ ไม่ได้แปลว่าราคาจะขึ้น',
      color: 0xf97316,
      fields: [
        { name: '🏆 อันดับ Trending', value: `#${Number(d.position)}`, inline: true },
        { name: '📊 อันดับ Market Cap', value: typeof d.marketCapRank === 'number' ? `#${d.marketCapRank}` : 'ไม่มีอันดับ', inline: true },
        { name: '⏱️ ราคา 24 ชม.', value: change, inline: true },
      ],
      ...(image ? { thumbnail: { url: image } } : {}),
      timestamp: new Date(event.detectedAt).toISOString(),
      footer: { text: FOOTER },
    }],
  };
}

/** Embed for TRENDING alerts (news mentions or CoinGecko trending searches). */
export function buildTrendAlert(event: RadarEvent): DiscordPayload {
  return event.details.trendType === 'coingecko' ? coingeckoTrend(event) : mentionsTrend(event);
}

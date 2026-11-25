import { createHash } from 'node:crypto';
import type { RadarEvent } from '../core/types.ts';
import { extractSignals, type NewsSignals } from './extract.ts';
import type { FeedConfig } from './feeds.ts';
import type { FeedItem } from './rss.ts';

/**
 * Title used for de-duplication across sources: lower-case, publisher suffix
 * (" - Reuters") removed, punctuation dropped. The same story from two feeds collapses.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s[-–|]\s[^-–|]{2,40}$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Key from the normalized title; falls back to the link when the title has no letters or digits. */
export function newsKey(title: string, link: string = ''): string {
  const basis = normalizeTitle(title) || `link:${link}`;
  return `news:${createHash('sha1').update(basis).digest('hex').slice(0, 20)}`;
}

/** Google News titles end with " - Publisher"; split that into the author field. */
function splitPublisher(feed: FeedConfig, item: FeedItem): { title: string; author: string | null } {
  if (feed.id.startsWith('google')) {
    const match = item.title.match(/^(.*)\s-\s([^-]{2,60})$/);
    if (match?.[1] && match[2]) return { title: match[1].trim(), author: match[2].trim() };
  }
  return { title: item.title, author: item.author };
}

export interface NewsEventResult {
  readonly event: RadarEvent;
  readonly signals: NewsSignals;
}

export function toNewsEvent(feed: FeedConfig, item: FeedItem, detectedAt: number): NewsEventResult {
  const { title, author } = splitPublisher(feed, item);
  const signals = extractSignals(title, item.summary);
  const symbol = signals.tickers[0] ?? signals.memeNames[0] ?? null;
  const event: RadarEvent = {
    key: newsKey(title, item.link),
    kind: 'news',
    chain: 'offchain',
    source: `news:${feed.id}`,
    tokenAddress: signals.addresses[0] ?? '',
    tokenName: null,
    tokenSymbol: symbol,
    txHash: item.link,
    detectedAt,
    details: {
      title,
      summary: item.summary,
      feed: feed.name,
      author,
      published: item.published,
      image: item.image,
      tickers: signals.tickers.join(','),
      memeNames: signals.memeNames.join(','),
      addresses: signals.addresses.join(','),
      tags: signals.tags.join(','),
      memeRelated: signals.memeRelated,
    },
    links: [{ label: feed.name, url: item.link }],
  };
  return { event, signals };
}

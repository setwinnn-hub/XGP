export interface FeedConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly intervalMs: number;
}

const MINUTE = 60_000;

function googleNews(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Free feeds verified live on 2026-11-25. CryptoSlate (HTTP 403) and Reddit
 * (unauthenticated RSS/JSON blocked: 403/404/429) are not included.
 */
export const NEWS_FEEDS: readonly FeedConfig[] = [
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', intervalMs: MINUTE },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', intervalMs: MINUTE },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', intervalMs: MINUTE },
  { id: 'blockworks', name: 'Blockworks', url: 'https://blockworks.co/feed', intervalMs: MINUTE },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', intervalMs: MINUTE },
  { id: 'bitcoinist', name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', intervalMs: 2 * MINUTE },
  { id: 'newsbtc', name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', intervalMs: 2 * MINUTE },
  { id: 'google-memecoin', name: 'Google News', url: googleNews('memecoin OR "meme coin" OR "pump.fun" when:1d'), intervalMs: 2 * MINUTE },
];

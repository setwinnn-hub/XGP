import type { Adapter, AdapterDeps } from '../core/adapter.ts';
import type { RadarEvent } from '../core/types.ts';
import { NEWS_FEEDS, type FeedConfig } from './feeds.ts';
import { toNewsEvent } from './news-event.ts';
import { fetchFeed, type FeedFetchState, type FeedItem } from './rss.ts';
import { TrendTracker, type TrendSignal } from './trend-tracker.ts';

const SOURCE = 'news';
/** All feeds failing for this long means the news radar is down. */
const STALE_AFTER_MS = 10 * 60_000;
const STAGGER_MS = 3_000;
const TREND_FRESH_MS = 60 * 60_000;

export interface NewsAdapterDeps extends AdapterDeps {
  readonly feeds?: readonly FeedConfig[];
  readonly onPublished: (key: string, publishedMs: number) => void;
  readonly fetchFn?: typeof fetch;
  readonly tracker?: TrendTracker;
}

export function trendEvent(signal: TrendSignal, at: number): RadarEvent {
  return {
    // Bucketed by the cooldown, so the DB key itself enforces "once per cooldown", even across restarts.
    key: `trend:mentions:${signal.symbol}:${Math.floor(at / signal.cooldownMs)}`,
    kind: 'trending',
    chain: 'offchain',
    source: 'news:mentions',
    tokenAddress: '',
    tokenName: null,
    tokenSymbol: signal.symbol,
    txHash: signal.examples.at(-1)?.link ?? '',
    detectedAt: at,
    details: {
      trendType: 'mentions',
      mentions: signal.mentions,
      sources: signal.sources.join(', '),
      windowMin: Math.round(signal.windowMs / 60_000),
      examples: JSON.stringify(signal.examples.map((m) => ({ title: m.title, link: m.link, source: m.source }))),
    },
    links: signal.examples.map((m) => ({ label: m.source, url: m.link })),
  };
}

/**
 * Polls crypto news RSS feeds and Google News. Every new headline is stored; the alert
 * filter decides which ones are meme-coin news worth sending. Coin mentions feed the
 * trend tracker, which flags coins suddenly covered by several outlets.
 */
export function createNewsAdapter(deps: NewsAdapterDeps): Adapter {
  const logger = deps.logger.child({ source: SOURCE });
  const feeds = deps.feeds ?? NEWS_FEEDS;
  const tracker = deps.tracker ?? new TrendTracker();
  let states = new Map<string, FeedFetchState>(feeds.map((f) => [f.id, { etag: null, lastModified: null }]));
  let timers: NodeJS.Timeout[] = [];
  deps.health.register(SOURCE, STALE_AFTER_MS);

  const poll = async (feed: FeedConfig): Promise<void> => {
    const result = await fetchFeed(feed.url, states.get(feed.id) ?? { etag: null, lastModified: null }, deps.fetchFn);
    if (result.status === 'error') return logger.warn('feed fetch failed', { feed: feed.id, error: result.error });
    deps.health.beat(SOURCE);
    if (result.status === 'not-modified') return;
    const detectedAt = Date.now();
    for (const item of result.items) {
      try {
        handleItem(feed, item, detectedAt);
      } catch (error: unknown) {
        logger.error('news item failed', { feed: feed.id, link: item.link, error: String(error) });
      }
    }
    // Saved only after every item was handled, so a crash re-reads the feed next time.
    states = new Map(states).set(feed.id, result.state);
  };

  const handleItem = (feed: FeedConfig, item: FeedItem, detectedAt: number): void => {
    const { event, signals } = toNewsEvent(feed, item, detectedAt);
    if (!deps.ingest(SOURCE, event) || item.published === null) return;
    deps.onPublished(event.key, item.published);
    // Only fresh meme-coin headlines count toward trends; the start-up backlog must not.
    if (!signals.memeRelated || detectedAt - item.published > TREND_FRESH_MS) return;
    // Google News aggregates many outlets: count the publisher, not "Google News", as the source.
    const outlet = typeof event.details.author === 'string' && feed.id.startsWith('google') ? event.details.author : feed.name;
    for (const symbol of new Set([...signals.tickers, ...signals.memeNames])) {
      const signal = tracker.record({ symbol, source: outlet, title: String(event.details.title), link: item.link, at: detectedAt });
      if (signal) deps.ingest(SOURCE, trendEvent(signal, detectedAt));
    }
  };

  return {
    name: SOURCE,
    start() {
      feeds.forEach((feed, i) => {
        const run = (): void => { poll(feed).catch((error: unknown) => logger.error('feed poll crashed', { feed: feed.id, error: String(error) })); };
        timers.push(setTimeout(() => {
          run();
          timers.push(setInterval(run, feed.intervalMs));
        }, i * STAGGER_MS));
      });
      logger.info('polling feeds', { feeds: feeds.map((f) => f.id) });
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    },
  };
}

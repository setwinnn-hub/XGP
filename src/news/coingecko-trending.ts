import type { Adapter, AdapterDeps } from '../core/adapter.ts';
import type { RadarEvent } from '../core/types.ts';

const SOURCE = 'coingecko:trending';
const URL = 'https://api.coingecko.com/api/v3/search/trending';
const POLL_MS = 10 * 60_000;
const STALE_AFTER_MS = 35 * 60_000;
/** One alert per coin per half day, even if it drops out and comes back. */
const COOLDOWN_BUCKET_MS = 12 * 60 * 60_000;
const TIMEOUT_MS = 10_000;

export interface TrendingCoin {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  /** 1 = most searched. */
  readonly position: number;
  readonly marketCapRank: number | null;
  readonly change24hPct: number | null;
  readonly image: string | null;
}

/** Parses CoinGecko /search/trending coins. Unknown shapes are skipped. */
export function parseTrending(body: unknown): TrendingCoin[] {
  const coins = (body as { coins?: unknown })?.coins;
  if (!Array.isArray(coins)) return [];
  return coins.flatMap((entry, index) => {
    const item = (entry as { item?: Record<string, unknown> }).item;
    if (!item || typeof item.id !== 'string' || typeof item.symbol !== 'string') return [];
    const data = item.data as { price_change_percentage_24h?: { usd?: unknown } } | undefined;
    const change = data?.price_change_percentage_24h?.usd;
    const image = typeof item.large === 'string' && /^https:\/\/([a-z0-9-]+\.)*coingecko\.com\//i.test(item.large) ? item.large : null;
    return [{
      id: item.id,
      symbol: item.symbol.toUpperCase(),
      name: typeof item.name === 'string' ? item.name : item.symbol,
      position: index + 1,
      marketCapRank: typeof item.market_cap_rank === 'number' ? item.market_cap_rank : null,
      change24hPct: typeof change === 'number' ? change : null,
      image,
    }];
  });
}

export function trendingEvent(coin: TrendingCoin, at: number): RadarEvent {
  const url = `https://www.coingecko.com/en/coins/${encodeURIComponent(coin.id)}`;
  return {
    key: `trend:coingecko:${coin.id}:${Math.floor(at / COOLDOWN_BUCKET_MS)}`,
    kind: 'trending',
    chain: 'offchain',
    source: SOURCE,
    tokenAddress: '',
    tokenName: coin.name,
    tokenSymbol: coin.symbol,
    txHash: url,
    detectedAt: at,
    details: {
      trendType: 'coingecko',
      position: coin.position,
      marketCapRank: coin.marketCapRank,
      change24hPct: coin.change24hPct,
      image: coin.image,
    },
    links: [{ label: 'CoinGecko', url }],
  };
}

export interface CoinGeckoTrendingDeps extends AdapterDeps {
  /** Skip coins ranked this high or better by market cap (majors such as BTC). */
  readonly minRank: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Alerts when a smaller coin newly enters CoinGecko's "trending searches" list.
 * The first snapshot after start is the baseline and alerts nothing.
 */
export function createCoinGeckoTrendingAdapter(deps: CoinGeckoTrendingDeps): Adapter {
  const logger = deps.logger.child({ source: SOURCE });
  let previous: ReadonlySet<string> | null = null;
  let timer: NodeJS.Timeout | null = null;
  deps.health.register(SOURCE, STALE_AFTER_MS);

  const poll = async (): Promise<void> => {
    const response = await (deps.fetchFn ?? fetch)(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return logger.warn('trending fetch failed', { status: response.status });
    const coins = parseTrending(await response.json());
    if (coins.length === 0) return logger.warn('trending response had no coins');
    deps.health.beat(SOURCE);
    const now = Date.now();
    if (previous) {
      const isSmall = (c: TrendingCoin): boolean => c.marketCapRank === null || c.marketCapRank > deps.minRank;
      for (const coin of coins.filter((c) => !previous?.has(c.id) && isSmall(c))) deps.ingest(SOURCE, trendingEvent(coin, now));
    }
    previous = new Set(coins.map((c) => c.id));
  };

  const run = (): void => { poll().catch((error: unknown) => logger.warn('trending poll failed', { error: String(error) })); };

  return {
    name: SOURCE,
    start() {
      run();
      timer = setInterval(run, POLL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

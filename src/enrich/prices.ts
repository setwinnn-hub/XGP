import { errorMessage, type Logger } from '../core/logger.ts';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,binancecoin&vs_currencies=usd';
const REFRESH_MS = 60_000;
/** Older than this, a price is not used: the alert shows no USD value instead of a stale one. */
const MAX_AGE_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

const SYMBOL_TO_ID: Readonly<Record<string, string>> = {
  SOL: 'solana', WSOL: 'solana',
  ETH: 'ethereum', WETH: 'ethereum',
  BNB: 'binancecoin', WBNB: 'binancecoin',
};

const STABLES = new Set(['USDC', 'USDT', 'BUSD', 'DAI', 'USD1']);

export function isStable(symbol: string): boolean {
  return STABLES.has(symbol.toUpperCase());
}

export interface PriceBook {
  /** USD value of an amount of a quote asset, or null if no fresh price is known. */
  usdValue(symbol: string, amount: number): number | null;
  start(): void;
  stop(): void;
}

/** Native coin prices from CoinGecko's free keyless API, refreshed every minute. */
export function createPriceBook(logger: Logger, fetchFn: typeof fetch = fetch, now: () => number = Date.now): PriceBook {
  let prices: Readonly<Record<string, number>> = {};
  let updatedAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetchFn(COINGECKO_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const body = (await response.json()) as Record<string, { usd?: unknown } | undefined>;
      const next = Object.fromEntries(
        Object.entries(body).flatMap(([id, value]) => (typeof value?.usd === 'number' && value.usd > 0 ? [[id, value.usd]] : [])),
      );
      if (Object.keys(next).length === 0) throw new Error('CoinGecko returned no prices');
      prices = next;
      updatedAt = now();
    } catch (error: unknown) {
      logger.warn('price refresh failed', { error: errorMessage(error) });
    }
  };

  return {
    usdValue(symbol, amount) {
      if (isStable(symbol)) return amount;
      const id = SYMBOL_TO_ID[symbol.toUpperCase()];
      const price = id ? prices[id] : undefined;
      if (price === undefined || now() - updatedAt > MAX_AGE_MS) return null;
      return amount * price;
    },
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

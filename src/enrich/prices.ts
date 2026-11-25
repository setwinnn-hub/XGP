import { errorMessage, type Logger } from '../core/logger.ts';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,binancecoin,tether&vs_currencies=usd,thb';
const FX_SOURCE = 'coingecko:tether(usd,thb)';

/** THB per 1 USD with where and when it came from (recorded with every THB value). */
export interface FxRate {
  readonly thbPerUsd: number;
  /** When the provider published the rate (not when we fetched it). */
  readonly at: number;
  readonly source: string;
  /** How long this rate may be used: minutes for live rates, about a day for daily reference rates. */
  readonly validForMs: number;
}

const FALLBACK_URL = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_SOURCE = 'exchangerate-api.com (daily)';
const DAILY_VALID_MS = 36 * 60 * 60_000;

type PriceBody = Record<string, { usd?: unknown; thb?: unknown } | undefined>;

/** THB/USD from CoinGecko's USDT price in both currencies; null if missing or implausible. */
export function fxFromBody(body: PriceBody, at: number): FxRate | null {
  const usd = body.tether?.usd;
  const thb = body.tether?.thb;
  if (typeof usd !== 'number' || typeof thb !== 'number' || usd <= 0) return null;
  return plausible(thb / usd) ? { thbPerUsd: thb / usd, at, source: FX_SOURCE, validForMs: MAX_AGE_MS } : null;
}

/** Sanity band: THB has traded far inside this range for decades; outside it the data is wrong. */
function plausible(rate: number): boolean {
  return Number.isFinite(rate) && rate > 20 && rate < 60;
}

/** Backup THB/USD (daily reference rate) so THB values do not depend on one provider. */
export async function fetchFallbackFx(fetchFn: typeof fetch = fetch): Promise<FxRate | null> {
  const response = await fetchFn(FALLBACK_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`exchangerate-api HTTP ${response.status}`);
  const body = (await response.json()) as { result?: string; rates?: { THB?: unknown }; time_last_update_unix?: unknown };
  const rate = body.rates?.THB;
  const at = typeof body.time_last_update_unix === 'number' ? body.time_last_update_unix * 1000 : null;
  if (body.result !== 'success' || typeof rate !== 'number' || !plausible(rate) || at === null) return null;
  return { thbPerUsd: rate, at, source: FALLBACK_SOURCE, validForMs: DAILY_VALID_MS };
}

/** One-off THB/USD lookup (for scripts): CoinGecko first, then the daily backup; null if both fail. */
export async function fetchFxRate(fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<FxRate | null> {
  try {
    const response = await fetchFn(COINGECKO_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) {
      const live = fxFromBody((await response.json()) as PriceBody, now());
      if (live) return live;
    }
  } catch {
    // fall through to the backup provider
  }
  return fetchFallbackFx(fetchFn).catch(() => null);
}

/** A rate is usable while it is younger than its own validity window. */
export function isFresh(rate: FxRate | null, now: number): rate is FxRate {
  return rate !== null && now - rate.at <= rate.validForMs;
}
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
  /** Latest fresh THB/USD rate, or null (callers then show USD only, never a stale THB value). */
  fxRate(): FxRate | null;
  start(): void;
  stop(): void;
}

/** Native coin prices from CoinGecko's free keyless API, refreshed every minute. */
export function createPriceBook(logger: Logger, fetchFn: typeof fetch = fetch, now: () => number = Date.now): PriceBook {
  let prices: Readonly<Record<string, number>> = {};
  let updatedAt = 0;
  let fx: FxRate | null = null;
  let timer: NodeJS.Timeout | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const response = await fetchFn(COINGECKO_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      const body = (await response.json()) as PriceBody;
      const next = Object.fromEntries(
        Object.entries(body).flatMap(([id, value]) => (typeof value?.usd === 'number' && value.usd > 0 ? [[id, value.usd]] : [])),
      );
      if (Object.keys(next).length === 0) throw new Error('CoinGecko returned no prices');
      prices = next;
      updatedAt = now();
      fx = fxFromBody(body, updatedAt) ?? fx;
    } catch (error: unknown) {
      logger.warn('price refresh failed', { error: errorMessage(error) });
    }
    if (!isFresh(fx, now())) {
      fx = (await fetchFallbackFx(fetchFn).catch(() => null)) ?? fx;
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
    fxRate() {
      return isFresh(fx, now()) ? fx : null;
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

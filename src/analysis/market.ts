import type { ChainId } from '../core/types.ts';

/** Market facts for one token, from its most liquid DexScreener pair. */
export interface MarketSnapshot {
  readonly pairUrl: string;
  readonly pairAddress: string | null;
  readonly dexId: string;
  readonly priceUsd: number | null;
  readonly liquidityUsd: number | null;
  /** DexScreener's circulating market cap. Never filled from FDV. */
  readonly marketCapUsd: number | null;
  /** Fully diluted valuation (price x total supply). */
  readonly fdvUsd: number | null;
  readonly volumeUsd: { readonly m5: number; readonly h1: number; readonly h24: number };
  readonly txnsH1: { readonly buys: number; readonly sells: number };
  readonly priceChangePct: { readonly m5: number | null; readonly h1: number | null; readonly h24: number | null };
  readonly pairCreatedAt: number | null;
  readonly socials: number;
  readonly websites: number;
  readonly imageUrl: string | null;
  /** Price in the pool's quote token (e.g. WBNB); priceUsd / priceNative = quote token USD price. */
  readonly priceNative?: number | null;
  /** Pool reserves as DexScreener reports them (token side and quote side). */
  readonly liquidityBase?: number | null;
  readonly liquidityQuote?: number | null;
  readonly quoteTokenAddress?: string | null;
}

const DEXSCREENER = 'https://api.dexscreener.com/tokens/v1';
const TIMEOUT_MS = 8_000;

type Raw = Record<string, unknown>;

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function obj(value: unknown): Raw {
  return value && typeof value === 'object' ? (value as Raw) : {};
}

function toSnapshot(pair: Raw): MarketSnapshot {
  const volume = obj(pair.volume);
  const h1 = obj(obj(pair.txns).h1);
  const change = obj(pair.priceChange);
  const info = obj(pair.info);
  // Token images are chosen by token creators: only accept DexScreener's own image CDN.
  const image = typeof info.imageUrl === 'string' && /^https:\/\/([a-z0-9-]+\.)*dexscreener\.com\//i.test(info.imageUrl) ? info.imageUrl : null;
  return {
    pairUrl: typeof pair.url === 'string' ? pair.url : '',
    pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
    dexId: typeof pair.dexId === 'string' ? pair.dexId : 'unknown',
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(obj(pair.liquidity).usd),
    marketCapUsd: num(pair.marketCap),
    fdvUsd: num(pair.fdv),
    volumeUsd: { m5: num(volume.m5) ?? 0, h1: num(volume.h1) ?? 0, h24: num(volume.h24) ?? 0 },
    txnsH1: { buys: num(h1.buys) ?? 0, sells: num(h1.sells) ?? 0 },
    priceChangePct: { m5: num(change.m5), h1: num(change.h1), h24: num(change.h24) },
    pairCreatedAt: num(pair.pairCreatedAt),
    socials: Array.isArray(info.socials) ? info.socials.length : 0,
    websites: Array.isArray(info.websites) ? info.websites.length : 0,
    imageUrl: image,
    priceNative: num(pair.priceNative),
    liquidityBase: num(obj(pair.liquidity).base),
    liquidityQuote: num(obj(pair.liquidity).quote),
    quoteTokenAddress: typeof obj(pair.quoteToken).address === 'string' ? String(obj(pair.quoteToken).address) : null,
  };
}

/** Picks the token's most liquid pair (bonding-curve pairs have no liquidity; then highest volume). */
export function pickBestPair(pairs: unknown, token: string): MarketSnapshot | null {
  if (!Array.isArray(pairs)) return null;
  const mine = (pairs as Raw[]).filter((p) => String(obj(p.baseToken).address ?? '').toLowerCase() === token.toLowerCase());
  if (mine.length === 0) return null;
  const score = (p: Raw): number => (num(obj(p.liquidity).usd) ?? 0) * 1e6 + (num(obj(p.volume).h24) ?? 0);
  const best = mine.reduce((a, b) => (score(b) > score(a) ? b : a));
  return toSnapshot(best);
}

/** Current market data for a token from DexScreener's free API (~300 req/min). */
export async function fetchMarket(chain: ChainId, token: string, fetchFn: typeof fetch = fetch): Promise<MarketSnapshot | null> {
  const response = await fetchFn(`${DEXSCREENER}/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  return pickBestPair(await response.json(), token);
}

/** DexScreener accepts up to 30 token addresses per request. */
const BATCH = 30;

/** Market data for many tokens of one chain in as few requests as possible (token -> snapshot). */
export async function fetchMarkets(chain: ChainId, tokens: readonly string[], fetchFn: typeof fetch = fetch): Promise<ReadonlyMap<string, MarketSnapshot>> {
  const out = new Map<string, MarketSnapshot>();
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const response = await fetchFn(`${DEXSCREENER}/${encodeURIComponent(chain)}/${batch.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
    const pairs: unknown = await response.json();
    for (const token of batch) {
      const snapshot = pickBestPair(pairs, token);
      if (snapshot) out.set(token.toLowerCase(), snapshot);
    }
  }
  return out;
}

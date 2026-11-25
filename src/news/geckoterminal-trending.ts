import type { Adapter, AdapterDeps } from '../core/adapter.ts';
import { errorMessage } from '../core/logger.ts';
import type { ChainId, RadarEvent } from '../core/types.ts';
import { sleep } from '../core/util.ts';

const SOURCE = 'geckoterminal:trending';
const API = 'https://api.geckoterminal.com/api/v2/networks';
/** GeckoTerminal's free API allows ~30 calls/min; 4 chains every 5 minutes stays far below. */
const POLL_MS = 5 * 60_000;
const GAP_MS = 2_500;
const STALE_AFTER_MS = 20 * 60_000;
/** A token re-enters analysis at most once per window while it stays trending. */
const BUCKET_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 15_000;

/** GeckoTerminal network ids for the chains the radar knows. */
const NETWORK: Readonly<Partial<Record<ChainId, string>>> = {
  solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc',
  arbitrum: 'arbitrum', polygon: 'polygon_pos', optimism: 'optimism', avalanche: 'avax',
};

/** Quote, wrapped-native and stable tokens trend because of volume, not because they are new. */
const NOT_A_PICK = /^(W?SOL|W?ETH|W?BNB|W?AVAX|W?POL|MATIC|USDC(\.E)?|USDT|USD1|DAI|FDUSD|USDS|PYUSD|CBBTC|W?BTC|BTCB)$/i;

export interface TrendingPool {
  readonly token: string;
  readonly symbol: string;
  readonly name: string;
  readonly pool: string;
  /** 1 = top of the chain's trending list. */
  readonly position: number;
  readonly volumeH1Usd: number | null;
  readonly changeH1Pct: number | null;
  readonly liquidityUsd: number | null;
}

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === 'object' ? (value as Raw) : {};
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Parses /networks/{net}/trending_pools?include=base_token. Unknown shapes are skipped. */
export function parseTrendingPools(body: unknown, _chain: ChainId): TrendingPool[] {
  const data = obj(body).data;
  if (!Array.isArray(data)) return [];
  const included = Array.isArray(obj(body).included) ? (obj(body).included as unknown[]).map(obj) : [];
  const tokens = new Map(included.map((t) => [String(t.id ?? ''), obj(t.attributes)] as const));
  return data.flatMap((row, index) => {
    const attrs = obj(obj(row).attributes);
    const baseId = obj(obj(obj(obj(row).relationships).base_token).data).id;
    if (typeof baseId !== 'string' || typeof attrs.address !== 'string') return [];
    const token = tokens.get(baseId);
    const address = typeof token?.address === 'string' ? token.address : baseId.slice(baseId.indexOf('_') + 1);
    const symbol = typeof token?.symbol === 'string' ? token.symbol : String(attrs.name ?? '').split(' / ')[0] ?? '';
    if (!address || !symbol || NOT_A_PICK.test(symbol)) return [];
    return [{
      token: address,
      symbol: symbol.slice(0, 20),
      name: typeof token?.name === 'string' ? token.name.slice(0, 80) : symbol,
      pool: attrs.address,
      position: index + 1,
      volumeH1Usd: num(obj(attrs.volume_usd).h1),
      changeH1Pct: num(obj(attrs.price_change_percentage).h1),
      liquidityUsd: num(attrs.reserve_in_usd),
    }];
  });
}

export function trendingPoolEvent(pool: TrendingPool, chain: ChainId, at: number): RadarEvent {
  const network = NETWORK[chain] ?? chain;
  const url = `https://www.geckoterminal.com/${network}/pools/${pool.pool}`;
  const id = chain === 'solana' ? pool.token : pool.token.toLowerCase();
  return {
    key: `trend:geckoterminal:${chain}:${id}:${Math.floor(at / BUCKET_MS)}`,
    kind: 'trending',
    chain,
    source: SOURCE,
    tokenAddress: pool.token,
    tokenName: pool.name,
    tokenSymbol: pool.symbol,
    txHash: url,
    detectedAt: at,
    details: {
      trendType: 'geckoterminal',
      position: pool.position,
      pool: pool.pool,
      volumeH1Usd: pool.volumeH1Usd,
      changeH1Pct: pool.changeH1Pct,
      liquidityUsd: pool.liquidityUsd,
    },
    links: [{ label: 'GeckoTerminal', url }],
  };
}

export interface GeckoTerminalTrendingDeps extends AdapterDeps {
  readonly chains: readonly ChainId[];
  readonly fetchFn?: typeof fetch;
  /** Pause between chain requests (tests pass 0). */
  readonly gapMs?: number;
}

/**
 * Tokens trending on GeckoTerminal (by trades and volume, per chain). They are not posted on
 * their own: each one is sent to analysis, which scores it, drops fake pools and alerts only
 * when it qualifies.
 */
export function createGeckoTerminalTrendingAdapter(deps: GeckoTerminalTrendingDeps): Adapter & { pollOnce(): Promise<void> } {
  const logger = deps.logger.child({ source: SOURCE });
  const chains = deps.chains.filter((c) => NETWORK[c] !== undefined);
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  deps.health.register(SOURCE, STALE_AFTER_MS);

  const pollChain = async (chain: ChainId): Promise<boolean> => {
    const url = `${API}/${NETWORK[chain]}/trending_pools?page=1&include=base_token`;
    const response = await (deps.fetchFn ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      logger.warn('trending pools fetch failed', { chain, status: response.status });
      return false;
    }
    const pools = parseTrendingPools(await response.json(), chain);
    const now = Date.now();
    for (const pool of pools) deps.ingest(SOURCE, trendingPoolEvent(pool, chain, now));
    return pools.length > 0;
  };

  const pollOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let answered = false;
      for (const [i, chain] of chains.entries()) {
        if (i > 0) await sleep(deps.gapMs ?? GAP_MS);
        const ok = await pollChain(chain).catch((error: unknown) => {
          logger.warn('trending pools poll failed', { chain, error: errorMessage(error) });
          return false;
        });
        answered ||= ok;
      }
      if (answered) deps.health.beat(SOURCE);
    } finally {
      running = false;
    }
  };

  return {
    name: SOURCE,
    pollOnce,
    start() {
      void pollOnce();
      timer = setInterval(() => void pollOnce(), POLL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

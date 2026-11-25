import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokenToAnalyse } from '../src/analysis/analysis-engine.ts';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { scoreToken } from '../src/analysis/score.ts';
import { silentLogger } from '../src/core/logger.ts';
import { HealthRegistry } from '../src/core/health.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { createGeckoTerminalTrendingAdapter, parseTrendingPools, trendingPoolEvent } from '../src/news/geckoterminal-trending.ts';
import { decideAlert } from '../src/notify/filters.ts';
import { testConfig } from './helpers.ts';

/** GeckoTerminal /networks/solana/trending_pools?include=base_token, seen live 2026-11-26, trimmed. */
const BODY = {
  data: [
    {
      id: 'solana_FnHWfV49ywCtGCDTyf34AVN8BiXxcgXUKqLctkrkP1gQ', type: 'pool',
      attributes: {
        address: 'FnHWfV49ywCtGCDTyf34AVN8BiXxcgXUKqLctkrkP1gQ', name: 'JIMMY / SOL', reserve_in_usd: '74008.811',
        price_change_percentage: { h1: '-25.714', h24: '-35.37' }, volume_usd: { h1: '274596.37', h24: '3391667.34' },
      },
      relationships: { base_token: { data: { id: 'solana_38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump', type: 'token' } } },
    },
    {
      id: 'solana_WSOLPOOL', type: 'pool',
      attributes: { address: 'WSOLPOOL', name: 'SOL / USDC' },
      relationships: { base_token: { data: { id: 'solana_So11111111111111111111111111111111111111112', type: 'token' } } },
    },
    { id: 'broken', type: 'pool', attributes: {}, relationships: {} },
  ],
  included: [
    { id: 'solana_38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump', type: 'token', attributes: { address: '38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump', name: 'Jimmy Rustles', symbol: 'JIMMY' } },
    { id: 'solana_So11111111111111111111111111111111111111112', type: 'token', attributes: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL' } },
  ],
};

const NOW = 1_795_600_000_000;

describe('parseTrendingPools', () => {
  it('reads the trending token, its pool and rank, and skips quote/major tokens and broken rows', () => {
    const pools = parseTrendingPools(BODY, 'solana');
    assert.equal(pools.length, 1);
    assert.deepEqual(pools[0], {
      token: '38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump', symbol: 'JIMMY', name: 'Jimmy Rustles',
      pool: 'FnHWfV49ywCtGCDTyf34AVN8BiXxcgXUKqLctkrkP1gQ', position: 1,
      volumeH1Usd: 274596.37, changeH1Pct: -25.714, liquidityUsd: 74008.811,
    });
  });

  it('returns nothing for an unexpected body', () => {
    assert.deepEqual(parseTrendingPools(null, 'solana'), []);
    assert.deepEqual(parseTrendingPools({ data: 'x' }, 'base'), []);
  });
});

describe('trendingPoolEvent', () => {
  const [pool] = parseTrendingPools(BODY, 'solana');
  const event = trendingPoolEvent(pool!, 'solana', NOW);

  it('is an on-chain trending event keyed per token and 6-hour window', () => {
    assert.equal(event.kind, 'trending');
    assert.equal(event.chain, 'solana');
    assert.equal(event.tokenAddress, '38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump');
    assert.equal(event.details.trendType, 'geckoterminal');
    assert.equal(event.key, trendingPoolEvent(pool!, 'solana', NOW + 60_000).key);
    assert.notEqual(event.key, trendingPoolEvent(pool!, 'solana', NOW + 7 * 3_600_000).key);
    assert.equal(event.links[0]?.url, 'https://www.geckoterminal.com/solana/pools/FnHWfV49ywCtGCDTyf34AVN8BiXxcgXUKqLctkrkP1gQ');
  });

  it('is not posted on its own (no spam) but is sent to analysis, flagged as trending', () => {
    assert.equal(decideAlert(event, testConfig()).alert, false);
    const ref = tokenToAnalyse(event, false);
    assert.equal(ref?.token, '38M2z4UCfZEkUHFzD48vhKQhFhNyRGto8pZbLjNipump');
    assert.equal(ref?.trending, true);
  });

  it('keeps CoinGecko (off-chain) trending alerts and does not analyse them', () => {
    const cg: RadarEvent = { ...event, chain: 'offchain', tokenAddress: '', details: { trendType: 'coingecko' } };
    assert.equal(decideAlert(cg, testConfig()).alert, true);
    assert.equal(tokenToAnalyse(cg, true), null);
  });
});

describe('scoreToken trending bonus', () => {
  const m: MarketSnapshot = {
    pairUrl: '', pairAddress: null, dexId: 'raydium', priceUsd: 1, liquidityUsd: 10_000, marketCapUsd: 100_000, fdvUsd: 100_000,
    volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 }, priceChangePct: { m5: 0, h1: 0, h24: 0 },
    pairCreatedAt: null, socials: 0, websites: 0, imageUrl: null,
  };

  it('adds points with a reason when the token is trending on GeckoTerminal', () => {
    const plain = scoreToken(m, null, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    const trending = scoreToken(m, null, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW, trending: true });
    assert.equal(trending.rawOpportunity - plain.rawOpportunity, 10);
    assert.ok(trending.positives.some((p) => p.includes('GeckoTerminal')));
  });
});

describe('GeckoTerminal trending adapter', () => {
  it('polls every chain, ingests trending tokens and beats health', async () => {
    const urls: string[] = [];
    const ingested: RadarEvent[] = [];
    const health = new HealthRegistry();
    const adapter = createGeckoTerminalTrendingAdapter({
      logger: silentLogger, health, ingest: (_n, e) => { ingested.push(e); return true; },
      chains: ['solana', 'base'], gapMs: 0,
      fetchFn: (async (url: string) => { urls.push(url); return new Response(JSON.stringify(BODY)); }) as typeof fetch,
    });
    await adapter.pollOnce();
    assert.deepEqual(urls, [
      'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1&include=base_token',
      'https://api.geckoterminal.com/api/v2/networks/base/trending_pools?page=1&include=base_token',
    ]);
    assert.equal(ingested.length, 2);
    assert.ok(health.snapshot().some((s) => s.name === 'geckoterminal:trending' && s.lastBeatAt !== null));
  });

  it('keeps going when one chain fails', async () => {
    const ingested: RadarEvent[] = [];
    let call = 0;
    const adapter = createGeckoTerminalTrendingAdapter({
      logger: silentLogger, health: new HealthRegistry(), ingest: (_n, e) => { ingested.push(e); return true; },
      chains: ['solana', 'base'], gapMs: 0,
      fetchFn: (async () => { call += 1; return call === 1 ? new Response('rate limited', { status: 429 }) : new Response(JSON.stringify(BODY)); }) as unknown as typeof fetch,
    });
    await adapter.pollOnce();
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0]?.chain, 'base');
  });
});

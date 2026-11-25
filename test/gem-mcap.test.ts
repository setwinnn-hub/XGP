import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { fetchFallbackFx, fetchFxRate, fxFromBody, isFresh, type FxRate } from '../src/enrich/prices.ts';
import { rangePosition, verifyMarketCap, type OnchainSupply } from '../src/gem/market-cap.ts';
import { createSettingsRepository, DEFAULT_GEM_SETTINGS, normalizeSettings } from '../src/gem/settings.ts';
import { openDatabase } from '../src/storage/db.ts';
import { fetchStub, jsonResponse } from './helpers.ts';

const NOW = 1_795_700_000_000;
const FX: FxRate = { thbPerUsd: 34, at: NOW, source: 'test', validForMs: 600_000 };

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    pairUrl: 'https://x', pairAddress: '0xpair', dexId: 'uniswap', priceUsd: 0.0001, liquidityUsd: 5_000,
    marketCapUsd: 10_000, fdvUsd: 10_000, volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 },
    priceChangePct: { m5: null, h1: null, h24: null }, pairCreatedAt: null, socials: 0, websites: 0, imageUrl: null,
    ...overrides,
  };
}

const supply = (total: number, burned = 0): OnchainSupply => ({ totalSupply: total, decimals: 18, burned, source: 'rpc', at: NOW });

describe('verifyMarketCap', () => {
  it('is VERIFIED when on-chain FDV matches DexScreener within 5%, and converts to THB', () => {
    const r = verifyMarketCap(market(), supply(100_000_000), FX, NOW);
    assert.equal(r.status, 'VERIFIED');
    assert.equal(r.fdvUsd, 10_000);
    assert.equal(r.circulatingMcapThb, 340_000);
    assert.deepEqual(r.sources, ['dexscreener', 'rpc', 'test']);
  });

  it('subtracts burned tokens from circulating supply but not from FDV', () => {
    const r = verifyMarketCap(market(), supply(100_000_000, 40_000_000), FX, NOW);
    assert.equal(r.circulatingSupply, 60_000_000);
    assert.equal(r.circulatingMcapUsd, 6_000);
    assert.equal(r.fdvUsd, 10_000);
  });

  it('downgrades to ESTIMATED / UNVERIFIED as the sources disagree more', () => {
    assert.equal(verifyMarketCap(market(), supply(110_000_000), FX, NOW).status, 'ESTIMATED');
    assert.equal(verifyMarketCap(market(), supply(200_000_000), FX, NOW).status, 'UNVERIFIED');
  });

  it('never fills market cap from FDV and is UNVERIFIED without a price', () => {
    const noPrice = verifyMarketCap(market({ priceUsd: null }), supply(1e9), FX, NOW);
    assert.equal(noPrice.status, 'UNVERIFIED');
    assert.equal(noPrice.circulatingMcapUsd, null);
    const noSupply = verifyMarketCap(market({ marketCapUsd: null, fdvUsd: 9_000 }), null, FX, NOW);
    assert.equal(noSupply.status, 'UNVERIFIED', 'FDV alone must not become a market cap');
    assert.equal(verifyMarketCap(market(), null, FX, NOW).status, 'ESTIMATED');
  });

  it('leaves THB empty (not guessed) when no exchange rate is available', () => {
    const r = verifyMarketCap(market(), supply(100_000_000), null, NOW);
    assert.equal(r.circulatingMcapThb, null);
    assert.equal(rangePosition(r, 66_000, 500_000), 'UNKNOWN');
  });

  it('places verified caps in or out of the THB range', () => {
    const r = verifyMarketCap(market(), supply(100_000_000), FX, NOW);
    assert.equal(rangePosition(r, 66_000, 500_000), 'IN_RANGE');
    assert.equal(rangePosition(r, 400_000, 500_000), 'BELOW');
    assert.equal(rangePosition(r, 1_000, 100_000), 'ABOVE');
  });
});

describe('THB exchange rate', () => {
  it('derives THB/USD from CoinGecko USDT prices and rejects implausible values', () => {
    const fx = fxFromBody({ tether: { usd: 1, thb: 34.03 } }, NOW);
    assert.equal(fx?.thbPerUsd, 34.03);
    assert.equal(fxFromBody({ tether: { usd: 1, thb: 3403 } }, NOW), null);
    assert.equal(fxFromBody({}, NOW), null);
  });

  it('falls back to the daily provider when CoinGecko fails, and records its source and time', async () => {
    const stub = fetchStub([
      () => jsonResponse({ status: { error_code: 429 } }, 429),
      () => jsonResponse({ result: 'success', rates: { THB: 33.94 }, time_last_update_unix: 1_795_651_351 }),
    ]);
    const fx = await fetchFxRate(stub.fn, () => NOW);
    assert.equal(fx?.thbPerUsd, 33.94);
    assert.equal(fx?.source, 'exchangerate-api.com (daily)');
    assert.equal(fx?.at, 1_795_651_351_000);
    assert.equal(await fetchFallbackFx(fetchStub([() => jsonResponse({ result: 'error' })]).fn), null);
  });

  it('expires rates by their own validity window', () => {
    assert.equal(isFresh(FX, NOW + 599_000), true);
    assert.equal(isFresh(FX, NOW + 601_000), false);
    assert.equal(isFresh(null, NOW), false);
  });
});

describe('gem settings', () => {
  it('defaults to 66,000–500,000 THB and rejects invalid ranges', () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_GEM_SETTINGS);
    assert.deepEqual(normalizeSettings({ minMarketCapThb: 900, maxMarketCapThb: 100 }), DEFAULT_GEM_SETTINGS);
    assert.deepEqual(normalizeSettings({ minMarketCapThb: 'x', maxMarketCapThb: 700_000 }), { ...DEFAULT_GEM_SETTINGS, minMarketCapThb: 66_000, maxMarketCapThb: 700_000 });
  });

  it('keeps valid liquidity thresholds and replaces invalid ones with defaults', () => {
    const s = normalizeSettings({ minLiquidityThb: 250_000, maxSlippagePct: -5, testTradeThb: 0 });
    assert.equal(s.minLiquidityThb, 250_000);
    assert.equal(s.maxSlippagePct, DEFAULT_GEM_SETTINGS.maxSlippagePct);
    assert.equal(s.testTradeThb, DEFAULT_GEM_SETTINGS.testTradeThb);
  });

  it('stores and reloads settings', () => {
    const repo = createSettingsRepository(openDatabase(':memory:'));
    assert.deepEqual(repo.get(), DEFAULT_GEM_SETTINGS);
    repo.save({ ...DEFAULT_GEM_SETTINGS, minMarketCapThb: 100_000, maxMarketCapThb: 300_000 });
    assert.deepEqual(repo.get(), { ...DEFAULT_GEM_SETTINGS, minMarketCapThb: 100_000, maxMarketCapThb: 300_000 });
  });
});

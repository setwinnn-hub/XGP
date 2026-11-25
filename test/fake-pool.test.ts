import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exitLiquidityUsd, fetchMarket, pickBestPair, type MarketSnapshot } from '../src/analysis/market.ts';
import { scoreToken } from '../src/analysis/score.ts';
import type { SecurityReport } from '../src/analysis/security.ts';

const NOW = 1_795_600_000_000;
const SOL_USD = 70.6;

const SAFE: SecurityReport = {
  honeypot: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 0, mintable: false, freezable: false,
  ownerCanChangeBalance: false, hiddenOwner: false, transferPausable: false, openSource: true,
  holderCount: 800, top10HoldersPct: 22, creatorPct: 1,
};

function pool(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    pairUrl: 'https://dexscreener.com/solana/pair', pairAddress: 'pair', dexId: 'raydium', priceUsd: 0.01,
    liquidityUsd: 100_000, marketCapUsd: 1_000_000, fdvUsd: 1_000_000,
    volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 },
    priceChangePct: { m5: 0, h1: 0, h24: 0 }, pairCreatedAt: NOW - 30 * 86_400_000, socials: 0, websites: 0, imageUrl: null,
    ...overrides,
  };
}

/** Fake "ANSEM" pool seen live 2026-11-25: $317.7M reported liquidity backed by 22.25 USDC. */
const FAKE_ANSEM = pool({ liquidityUsd: 317_701_563, marketCapUsd: 317_924_068, priceUsd: 0.3179, priceNative: 0.3179, liquidityBase: 999_300_059, liquidityQuote: 22.2481 });
/** Fake "DCTY" pool seen live 2026-11-25: $17.1M reported liquidity backed by 290 SOL. */
const FAKE_DCTY = pool({ liquidityUsd: 17_075_388, marketCapUsd: 17_694_330, priceUsd: 0.01769, priceNative: 0.01769 / SOL_USD, liquidityBase: 963_863_492, liquidityQuote: 290.2726, volumeUsd: { m5: 0, h1: 29, h24: 1_703_187 }, txnsH1: { buys: 5, sells: 0 } });
/** Real ANSEM pumpswap pool the same day: both sides balanced. */
const REAL_ANSEM = pool({ dexId: 'pumpswap', liquidityUsd: 754_102, marketCapUsd: 18_662_659, priceUsd: 0.01871, priceNative: 0.01871 / SOL_USD, liquidityBase: 20_111_776, liquidityQuote: 5_345.5, volumeUsd: { m5: 1_000, h1: 20_803, h24: 2_018_551 }, txnsH1: { buys: 114, sells: 69 } });

describe('exitLiquidityUsd', () => {
  it('is twice the real quote-side value, capped at the reported liquidity', () => {
    assert.ok(Math.abs((exitLiquidityUsd(FAKE_ANSEM) ?? 0) - 44.5) < 0.1);
    assert.ok(Math.abs((exitLiquidityUsd(FAKE_DCTY) ?? 0) - 2 * 290.2726 * SOL_USD) < 1);
    assert.equal(exitLiquidityUsd(pool({ liquidityUsd: 1_000, priceNative: 1, priceUsd: 1, liquidityQuote: 10_000 })), 1_000);
  });

  it('is null when DexScreener gives no quote reserve or native price', () => {
    assert.equal(exitLiquidityUsd(pool({})), null);
    assert.equal(exitLiquidityUsd(pool({ priceNative: 0.5 })), null);
    assert.equal(exitLiquidityUsd(pool({ liquidityUsd: null, priceNative: 1, liquidityQuote: 1 })), null);
  });
});

describe('pickBestPair with a fake pool next to the real one', () => {
  const pair = (address: string, liqUsd: number, quote: number, priceNative: number, vol24: number) => ({
    url: `https://dexscreener.com/solana/${address}`, pairAddress: address, dexId: 'raydium',
    baseToken: { address: 'TokenMint' }, priceUsd: '0.0187', priceNative: String(priceNative),
    liquidity: { usd: liqUsd, base: 1, quote }, volume: { h24: vol24 },
  });

  it('picks the pool with the most real (quote-side) liquidity, not the biggest reported number', () => {
    const fake = pair('FakePool', 317_701_563, 22.25, 0.0187, 0);
    const real = pair('RealPool', 754_102, 5_345.5, 0.0187 / SOL_USD, 2_018_551);
    assert.equal(pickBestPair([fake, real], 'TokenMint')?.pairAddress, 'RealPool');
  });

  it('falls back to reported liquidity when the quote side is unknown', () => {
    const a = { ...pair('A', 10_000, 0, 1, 0), liquidity: { usd: 10_000 } };
    const b = { ...pair('B', 50_000, 0, 1, 0), liquidity: { usd: 50_000 } };
    assert.equal(pickBestPair([a, b], 'TokenMint')?.pairAddress, 'B');
  });
});

describe('fetchMarket', () => {
  it('reads every pool of the token (token-pairs), not the single pair tokens/v1 returns', async () => {
    const urls: string[] = [];
    const body = [
      { pairAddress: 'Minor', dexId: 'orca', baseToken: { address: 'TRUMP' }, priceUsd: '0.87', priceNative: '0.0123', liquidity: { usd: 118_000, quote: 375 }, volume: { h24: 1 } },
      { pairAddress: 'Main', dexId: 'meteora', baseToken: { address: 'TRUMP' }, priceUsd: '0.87', priceNative: '0.87', liquidity: { usd: 3_801_530, quote: 1_900_000 }, volume: { h24: 1 } },
    ];
    const fakeFetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(body)); }) as typeof fetch;
    const m = await fetchMarket('solana', 'TRUMP', fakeFetch);
    assert.equal(urls[0], 'https://api.dexscreener.com/token-pairs/v1/solana/TRUMP');
    assert.equal(m?.pairAddress, 'Main');
  });
});

describe('scoreToken: market cap far above liquidity', () => {
  it('does not call an established large cap a fake just because its DEX pool is small next to its cap', () => {
    const pepeLike = pool({ liquidityUsd: 22_980_000, marketCapUsd: 1_600_000_000, volumeUsd: { m5: 50_000, h1: 900_000, h24: 20_000_000 }, txnsH1: { buys: 400, sells: 380 } });
    const score = scoreToken(pepeLike, SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.ok(!score.risks.some((r) => r.includes('สูงเกินสภาพคล่อง')), score.risks.join('\n'));
  });

  it('still flags a thin pool carrying a huge market cap', () => {
    const thin = pool({ liquidityUsd: 90_000, marketCapUsd: 20_000_000 });
    const score = scoreToken(thin, SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.ok(score.risks.some((r) => r.includes('สูงเกินสภาพคล่อง')), score.risks.join('\n'));
  });
});

describe('scoreToken: liquidity inflated by the token\'s own price', () => {
  for (const [name, fake] of [['ANSEM', FAKE_ANSEM], ['DCTY', FAKE_DCTY]] as const) {
    it(`flags the fake ${name} pool as HIGH risk and gives no liquidity points`, () => {
      const score = scoreToken(fake, SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
      assert.equal(score.risk, 'HIGH');
      assert.ok(score.risks.some((r) => r.includes('pool ปลอม')), score.risks.join('\n'));
      assert.ok(!score.positives.some((p) => p.includes('สภาพคล่องดี')), score.positives.join('\n'));
    });
  }

  it('does not flag the real, balanced ANSEM pool', () => {
    const score = scoreToken(REAL_ANSEM, SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.ok(!score.risks.some((r) => r.includes('pool ปลอม')), score.risks.join('\n'));
    assert.ok(score.positives.some((p) => p.includes('สภาพคล่องดี')));
  });

  it('judges liquidity from the reported number when the quote side is unknown', () => {
    const score = scoreToken(pool({ liquidityUsd: 80_000 }), SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.ok(score.positives.some((p) => p.includes('สภาพคล่องดี $80.0k')));
  });
});

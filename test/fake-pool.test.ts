import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exitLiquidityUsd, type MarketSnapshot } from '../src/analysis/market.ts';
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

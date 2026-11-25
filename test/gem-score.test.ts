import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { parseSecurity } from '../src/analysis/security.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { FxRate } from '../src/enrich/prices.ts';
import { detectAccumulation } from '../src/gem/accumulation.ts';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, scoreGem, type ScoreInput } from '../src/gem/gem-score.ts';
import { parseHoneypot } from '../src/gem/honeypot.ts';
import { assessLiquidity } from '../src/gem/liquidity.ts';
import { rangePosition, verifyMarketCap } from '../src/gem/market-cap.ts';
import { createScoreEvaluator } from '../src/gem/score-evaluator.ts';
import { createScoreStore } from '../src/gem/score-store.ts';
import { assessSecurity } from '../src/gem/security-engine.ts';
import { DEFAULT_GEM_SETTINGS, normalizeSettings } from '../src/gem/settings.ts';
import type { SwapRow } from '../src/gem/swap-store.ts';
import { openDatabase } from '../src/storage/db.ts';

const NOW = 1_795_700_000_000;
const MIN = 60_000;
const FX: FxRate = { thbPerUsd: 34, at: NOW, source: 'test', validForMs: 600_000 };
const TOKEN = '0x00000000000000000000000000000000000000aa';

let seq = 0;
const buy = (wallet: string, minutesAgo: number): SwapRow => {
  seq += 1;
  return { chain: 'bsc', token: TOKEN, txHash: `0x${seq}`, side: 'BUY', wallet, tokenAmount: 100 + seq * 7, block: 1_000 + seq, blockTime: NOW - minutesAgo * MIN, nonce: 40, feeGwei: 0.1 };
};
const buyers = (prefix: string, n: number, fromMin: number, toMin: number): SwapRow[] =>
  Array.from({ length: n }, (_, i) => buy(`${prefix}${i}`, fromMin - ((fromMin - toMin) * (i + 0.5)) / n));

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    pairUrl: '', pairAddress: '0xpair', dexId: 'pancakeswap', priceUsd: 0.0001, liquidityUsd: 8_000, marketCapUsd: 10_000, fdvUsd: 10_000,
    volumeUsd: { m5: 750, h1: 3_000, h24: 5_000 }, txnsH1: { buys: 60, sells: 10 }, priceChangePct: { m5: 2, h1: 10, h24: null },
    pairCreatedAt: NOW - 2 * 3_600_000, socials: 0, websites: 0, imageUrl: null,
    priceNative: 0.0001 / 600, liquidityBase: 40_000_000, liquidityQuote: 6.66, quoteTokenAddress: '0xwbnb',
    ...overrides,
  };
}

const CLEAN_GOPLUS = {
  is_honeypot: '0', cannot_sell_all: '0', buy_tax: '0', sell_tax: '0', is_mintable: '0', owner_change_balance: '0', hidden_owner: '0',
  transfer_pausable: '0', is_open_source: '1', creator_percent: '0', cannot_buy: '0', transfer_tax: '0', personal_slippage_modifiable: '0',
  external_call: '0', selfdestruct: '0', honeypot_with_same_creator: '0', owner_address: '0x0000000000000000000000000000000000000000',
  is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0', can_take_back_ownership: '0', slippage_modifiable: '0', trading_cooldown: '0',
  owner_percent: '0', holders: [{ address: '0xa', percent: '0.05', is_contract: 0 }],
  lp_holders: [{ address: '0x000000000000000000000000000000000000dead', percent: '1', is_locked: 1 }],
};
const HONEYPOT_OK = parseHoneypot({ simulationSuccess: true, honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0 }, contractCode: { isProxy: false, openSource: true } });

/** A strong, fully verified early token built through the real Stage 5–8 functions. */
function strong(overrides: Partial<ScoreInput> = {}, goplusOverrides: Record<string, unknown> = {}): ScoreInput {
  const swaps = [...buyers('early', 8, 15, 5), ...buyers('late', 22, 5, 0)];
  const accumulation = detectAccumulation({ swaps, now: NOW, coverageSince: NOW - 120 * MIN, smartWallets: new Set(['late1', 'late2', 'late3']), price: { changeM5Pct: 2, changeH1Pct: 10 } });
  const m = market();
  const liquidity = assessLiquidity({
    market: m, reserves: null, poolFee: 0.0025, thbPerUsd: 34, settings: { ...DEFAULT_GEM_SETTINGS, minLiquidityThb: 100_000 }, now: NOW, history: [],
    activity: { buys60m: 30, uniqueBuyers60m: 30, independentBuyers15m: 30, dexTxnsH1: 70 },
  });
  const security = assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: parseSecurity({ ...CLEAN_GOPLUS, ...goplusOverrides }, false), honeypot: HONEYPOT_OK, liquidityFlags: liquidity.flags });
  const marketCap = verifyMarketCap(m, { totalSupply: 100_000_000, decimals: 18, burned: 0, source: 'rpc', at: NOW }, FX, NOW);
  return {
    accumulation, liquidity, security, marketCap, rangePosition: rangePosition(marketCap, 66_000, 500_000), market: m,
    trackedWallets: 5, newsMentions24h: 2, weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS, ...overrides,
  };
}

describe('scoreGem', () => {
  it('gives HIGH_POTENTIAL to a strong token whose market cap and security were verified', () => {
    const input = strong();
    assert.equal(input.accumulation.status, 'PRE_PUMP');
    assert.equal(input.marketCap?.status, 'VERIFIED');
    assert.equal(input.security.level, 'NO_ISSUES_FOUND');
    const s = scoreGem(input);
    assert.equal(s.classification, 'HIGH_POTENTIAL');
    assert.ok(s.score >= 70, `score ${s.score}`);
    assert.equal(s.confidence, 95, 'holder growth has no free source, so 5 of 100 never has evidence');
  });

  it('never lets a high score pass a critical security problem (hard gate)', () => {
    const s = scoreGem(strong({}, { is_honeypot: '1' }));
    assert.equal(s.classification, 'REJECTED');
    assert.ok(s.gateReasons.some((r) => r.includes('Honeypot')));
  });

  it('classifies high-risk security, coordinated buying and thin liquidity as HIGH_RISK', () => {
    assert.equal(scoreGem(strong({}, { slippage_modifiable: '1' })).classification, 'HIGH_RISK');
    const thin = strong();
    const thinLiquidity = { ...thin.liquidity, liquidity: 'INSUFFICIENT_LIQUIDITY' as const };
    assert.equal(scoreGem({ ...thin, liquidity: thinLiquidity }).classification, 'HIGH_RISK');
  });

  it('rejects tokens that already pumped or sit above the market cap range', () => {
    const pumped = strong();
    assert.equal(scoreGem({ ...pumped, accumulation: { ...pumped.accumulation, status: 'ALREADY_PUMPED' } }).classification, 'REJECTED');
    assert.equal(scoreGem(strong({ rangePosition: 'ABOVE' })).classification, 'REJECTED');
  });

  it('earns no points from missing data and keeps unverified market cap out of HIGH_POTENTIAL', () => {
    const base = strong();
    const unknownSecurity = { ...base.security, level: 'UNKNOWN' as const };
    const s = scoreGem({ ...base, security: unknownSecurity, marketCap: null, rangePosition: 'UNKNOWN', trackedWallets: 0 });
    for (const c of ['riskAssessment', 'marketCapPosition', 'smartMoney'] as const) {
      const cat = s.categories.find((x) => x.category === c)!;
      assert.equal(cat.evidence, false);
      assert.equal(cat.points, 0);
    }
    assert.equal(s.classification, 'EARLY_WATCH');
    assert.equal(s.confidence, 65, 'smart money 20 + risk 5 + market cap 5 + holders 5 had no evidence');
    assert.ok(s.gateReasons.includes('market cap ยังไม่ VERIFIED'));
    assert.ok(s.gateReasons.includes('ตรวจความปลอดภัยหลักไม่ได้'));
  });

  it('puts quiet tokens in LOW_ACTIVITY', () => {
    const base = strong();
    const s = scoreGem({ ...base, liquidity: { ...base.liquidity, activity: 'LOW_ACTIVITY' } });
    assert.equal(s.classification, 'LOW_ACTIVITY');
  });

  it('follows adjusted weights and repairs invalid stored weights', () => {
    const base = strong();
    const noSmart = scoreGem({ ...base, weights: { ...DEFAULT_WEIGHTS, smartMoney: 0 } });
    assert.equal(noSmart.categories.find((c) => c.category === 'smartMoney')!.weight, 0);
    const settings = normalizeSettings({ weights: { smartMoney: -5, socialMomentum: 50 }, thresholds: { highPotentialScore: 30, earlyWatchScore: 60 } });
    assert.equal(settings.weights.smartMoney, DEFAULT_WEIGHTS.smartMoney);
    assert.equal(settings.weights.socialMomentum, 50);
    assert.equal(settings.thresholds.highPotentialScore, 60, 'thresholds are put back in order');
    assert.deepEqual(normalizeSettings({ weights: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0])) }).weights, DEFAULT_WEIGHTS);
  });
});

describe('score evaluator and store', () => {
  it('records on class change, keeps history, and limits supply lookups by budget', async () => {
    const store = createScoreStore(openDatabase(':memory:'));
    let supplyCalls = 0;
    const evaluator = createScoreEvaluator({
      store, settings: () => DEFAULT_GEM_SETTINGS, fx: () => FX, now: () => NOW,
      fetchSupply: async () => { supplyCalls += 1; return { totalSupply: 100_000_000, decimals: 18, burned: 0, source: 'rpc', at: NOW }; },
      trackedWallets: () => 5, newsMentions: () => 2,
    }, silentLogger);
    const input = strong();
    const watch = { chain: 'bsc', token: TOKEN, pool: '0xpair', poolKind: 'pair' as const, symbol: 'GEM', reason: 't', addedAt: NOW - 7_200_000, expiresAt: NOW + 3_600_000 };
    const ctx = { chain: 'bsc' as const, watch, market: input.market, accumulation: input.accumulation, liquidity: input.liquidity, security: input.security, asOf: NOW };
    const noBudget = await evaluator.evaluate({ ...ctx, allowSupplyFetch: false });
    assert.equal(supplyCalls, 0);
    assert.notEqual(noBudget.gem.classification, 'HIGH_POTENTIAL', 'without supply the market cap is not verified');
    const first = await evaluator.evaluate({ ...ctx, allowSupplyFetch: true });
    assert.equal(first.gem.classification, 'HIGH_POTENTIAL');
    assert.equal(supplyCalls, 1);
    await evaluator.evaluate({ ...ctx, allowSupplyFetch: true });
    assert.equal(supplyCalls, 1, 'supply cached');
    assert.equal(store.history('bsc', TOKEN, 10).length, 2, 'two classes recorded, the unchanged third pass is not');
    assert.equal(store.current(NOW - 60_000)[0]?.gem.classification, 'HIGH_POTENTIAL');
  });
});

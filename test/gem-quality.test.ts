import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { parseSecurity, type SecurityReport } from '../src/analysis/security.ts';
import { silentLogger } from '../src/core/logger.ts';
import { fetchHoneypot, parseHoneypot, type HoneypotResult } from '../src/gem/honeypot.ts';
import { assessLiquidity, type ActivityInput, type LiquidityInput } from '../src/gem/liquidity.ts';
import { createSecurityCache } from '../src/gem/security-cache.ts';
import { assessSecurity } from '../src/gem/security-engine.ts';
import { DEFAULT_GEM_SETTINGS } from '../src/gem/settings.ts';
import { cpSlippagePct, estimateSlippage } from '../src/gem/slippage.ts';
import { fetchStub, jsonResponse } from './helpers.ts';

const NOW = 1_795_700_000_000;
const THB = 34;

/** honeypot.is answer for JIMMY (ETH) captured live on 2026-11-25, trimmed to the fields used. */
const LIVE_HONEYPOT = {
  token: { name: 'JIMMY', symbol: 'JIMMY', decimals: 9 },
  summary: { risk: 'low', riskLevel: 1, flags: [] },
  simulationSuccess: true,
  honeypotResult: { isHoneypot: false },
  simulationResult: { buyTax: 0, sellTax: 0, transferTax: 0, buyGas: '175931', sellGas: '109134' },
  holderAnalysis: { holders: '33', successful: '33', failed: '0', siphoned: '0' },
  flags: [],
  contractCode: { openSource: true, rootOpenSource: true, isProxy: false, hasProxyCalls: false },
};

/** GoPlus lp_holders / dex shape captured live (BSC token 0xc36C…7777) on 2026-11-25. */
const LIVE_GOPLUS_EXTRA = {
  owner_address: '0x0000000000000000000000000000000000000000', is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0',
  can_take_back_ownership: '0', slippage_modifiable: '0', trading_cooldown: '0', owner_percent: '0.000000',
  lp_holders: [
    { address: '0x000000000000000000000000000000000000dead', tag: '', is_contract: 0, percent: '0.999999999999999999', is_locked: 1 },
    { address: '0x0000000000000000000000000000000000000000', tag: 'Null Address', is_contract: 0, percent: '0.000000000000000000', is_locked: 1 },
  ],
  dex: [
    { liquidity_type: 'UniV2', name: 'PancakeV2', liquidity: '16743.84', pool_fee: '0.0025', pair: '0x9125ca0467e0207743f76e064be498e62b5b145a' },
    { liquidity_type: 'UniV4', name: 'UniswapV4', liquidity: '118.28', pool_fee: '0.0993', pair: '0xbad17787d07cd67c39b1c94b5ae943a4500cb979b63260245bea81957aa70b41' },
  ],
};

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    pairUrl: '', pairAddress: '0xpair', dexId: 'pancakeswap', priceUsd: 0.002, liquidityUsd: 30_000, marketCapUsd: 50_000, fdvUsd: 50_000,
    volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 40, sells: 30 }, priceChangePct: { m5: 1, h1: 5, h24: null },
    pairCreatedAt: NOW - 3 * 3_600_000, socials: 0, websites: 0, imageUrl: null,
    priceNative: 0.000002, liquidityBase: 7_500_000, liquidityQuote: 15, quoteTokenAddress: '0xwbnb',
    ...overrides,
  };
}

const active: ActivityInput = { buys60m: 50, uniqueBuyers60m: 30, independentBuyers15m: 12, dexTxnsH1: 70 };

const liq = (overrides: Partial<LiquidityInput> = {}): LiquidityInput => ({
  market: market(), reserves: { pair: '0xpair', tokenReserve: 7_500_000, quoteReserve: 15, quoteToken: '0xwbnb' },
  poolFee: 0.0025, thbPerUsd: THB, settings: DEFAULT_GEM_SETTINGS, activity: active, history: [], now: NOW, ...overrides,
});

describe('constant-product slippage', () => {
  it('matches the x*y=k formula and grows with trade size', () => {
    // 1% of the quote reserve, no fee: impact = 1 - 1/(1.01) = 0.990%
    assert.ok(Math.abs(cpSlippagePct(100, 1000, 1, 0) - 0.990099) < 1e-5);
    const small = estimateSlippage(1_000_000, 10, 0.1, 0.003);
    const big = estimateSlippage(1_000_000, 10, 1, 0.003);
    assert.ok(big.buyPct > small.buyPct && small.buyPct > 0.3, 'includes the 0.3% fee');
    assert.throws(() => cpSlippagePct(0, 1, 1, 0));
  });
});

describe('assessLiquidity', () => {
  it('uses on-chain V2 reserves priced through the token price, and the pool fee', () => {
    const r = assessLiquidity(liq());
    assert.equal(r.liquiditySource, 'onchain-reserves');
    assert.equal(r.slippageMethod, 'V2_RESERVES');
    assert.ok(Math.abs((r.liquidityUsd ?? 0) - 30_000) < 1);
    assert.equal(r.liquidity, 'OK');
    assert.equal(r.activity, 'ACTIVE');
  });

  it('keeps activity, liquidity and slippage as separate verdicts', () => {
    const noTrades = assessLiquidity(liq({ activity: { ...active, buys60m: 0 } }));
    assert.equal(noTrades.activity, 'NO_REAL_ACTIVITY');
    assert.equal(noTrades.liquidity, 'OK', 'no trades does not make the pool illiquid');
    const thin = assessLiquidity(liq({ reserves: null, market: market({ liquidityUsd: 1_000 }), activity: active }));
    assert.equal(thin.liquidity, 'INSUFFICIENT_LIQUIDITY');
    assert.equal(thin.activity, 'ACTIVE');
    const big = assessLiquidity(liq({ settings: { ...DEFAULT_GEM_SETTINGS, testTradeThb: 200_000 } }));
    assert.equal(big.liquidity, 'INSUFFICIENT_LIQUIDITY', 'slippage over the limit for a large trade');
  });

  it('LOW_ACTIVITY while our hour is filling, ACTIVE once 15 minutes pass the bar', () => {
    const filling = assessLiquidity(liq({ activity: { buys60m: null, uniqueBuyers60m: null, independentBuyers15m: null, dexTxnsH1: 2000 } }));
    assert.equal(filling.activity, 'LOW_ACTIVITY');
    const fifteen = assessLiquidity(liq({ activity: { buys60m: null, uniqueBuyers60m: null, independentBuyers15m: 20, buys15m: 40, uniqueBuyers15m: 25, dexTxnsH1: 2000 } }));
    assert.equal(fifteen.activity, 'ACTIVE');
  });

  it('is UNKNOWN without an FX rate, estimates for concentrated pools, flags drops and mismatches', () => {
    assert.equal(assessLiquidity(liq({ thbPerUsd: null })).liquidity, 'UNKNOWN');
    const v3 = assessLiquidity(liq({ reserves: null }));
    assert.equal(v3.slippageMethod, 'CONSTANT_PRODUCT_ESTIMATE');
    const drop = assessLiquidity(liq({ history: [{ at: NOW - 20 * 60_000, liquidityUsd: 80_000 }] }));
    assert.ok(drop.flags.includes('LIQUIDITY_DROP'));
    const mismatch = assessLiquidity(liq({ market: market({ liquidityQuote: 30 }) }));
    assert.ok(mismatch.flags.includes('RESERVES_MISMATCH'));
  });
});

describe('one-sided concentrated pools', () => {
  it('judges exit liquidity from the quote side and does not invent a buy slippage (live V4 shape)', () => {
    // DexScreener for Base token 0xC21C… (Uniswap V4) on 2026-11-25: 999,975,808 tokens vs 0.00005741 ETH.
    const v4 = market({ liquidityUsd: 4011.31, liquidityBase: 999_975_808, liquidityQuote: 0.00005741, priceUsd: 0.000004011, priceNative: 0.000000002373 });
    const r = assessLiquidity(liq({ market: v4, reserves: null }));
    assert.ok(r.flags.includes('ONE_SIDED'));
    assert.ok((r.exitLiquidityUsd ?? 1) < 1);
    assert.equal(r.buySlippagePct, null);
    assert.ok((r.sellSlippagePct ?? 0) > 99);
    assert.equal(r.liquidity, 'INSUFFICIENT_LIQUIDITY');
  });
});

describe('GoPlus extra fields and honeypot.is', () => {
  it('reads LP burn/lock share, pool fees and renounced owner from the live shape', () => {
    const x = parseSecurity(LIVE_GOPLUS_EXTRA, false).extra!;
    assert.ok(Math.abs((x.lpLockedPct ?? 0) - 100) < 1e-6);
    assert.equal(x.poolFees['0x9125ca0467e0207743f76e064be498e62b5b145a'], 0.0025);
    assert.equal(x.ownerRenounced, true);
    assert.equal(x.proxy, false);
  });

  it('parses a live simulation and reports uncovered pairs as NOT_COVERED', async () => {
    const r = parseHoneypot(LIVE_HONEYPOT);
    assert.equal(r.status, 'SIMULATED');
    assert.equal(r.isHoneypot, false);
    assert.equal(r.sellTaxPct, 0);
    const stub = fetchStub([() => jsonResponse({ code: 404, error: 'pair not found' }, 404)]);
    assert.equal((await fetchHoneypot('bsc', '0xabc', stub.fn))?.status, 'NOT_COVERED');
    assert.match(stub.calls[0]!.url, /chainID=56/);
    assert.equal(await fetchHoneypot('solana', 'Mint', stub.fn), null);
  });
});

describe('assessSecurity', () => {
  const goplus = (overrides: Partial<SecurityReport> = {}): SecurityReport => ({
    ...parseSecurity({ ...LIVE_GOPLUS_EXTRA, is_honeypot: '0', cannot_sell_all: '0', buy_tax: '0', sell_tax: '0', is_mintable: '0', owner_change_balance: '0', hidden_owner: '0', transfer_pausable: '0', is_open_source: '1', creator_percent: '0', cannot_buy: '0', transfer_tax: '0', personal_slippage_modifiable: '0', external_call: '0', selfdestruct: '0', honeypot_with_same_creator: '0', holders: [{ address: '0xa', percent: '0.05', is_contract: 0 }] }, false),
    ...overrides,
  });
  const hp = (overrides: Partial<HoneypotResult> = {}): HoneypotResult => ({ ...parseHoneypot(LIVE_HONEYPOT), ...overrides });

  it('says NO_ISSUES_FOUND (never SAFE) when every source answered cleanly', () => {
    const a = assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: goplus(), honeypot: hp(), liquidityFlags: [] });
    assert.equal(a.level, 'NO_ISSUES_FOUND');
    assert.ok(a.reasons.some((r) => r.includes('ไม่ได้แปลว่าปลอดภัย')));
  });

  it('takes the worse answer when sources disagree, and suppresses gem alerts on critical', () => {
    const a = assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: goplus(), honeypot: hp({ isHoneypot: true }), liquidityFlags: [] });
    assert.equal(a.level, 'CRITICAL');
    assert.equal(a.suppressGemAlert, true);
    assert.equal(a.conflicts.length, 1);
  });

  it('is UNKNOWN when the core checks could not be made (brand-new token)', () => {
    const a = assessSecurity({ chain: 'base', poolKind: 'v4', goplus: null, honeypot: hp({ status: 'NOT_COVERED', isHoneypot: null, sellTaxPct: null, buyTaxPct: null }), liquidityFlags: [] });
    assert.equal(a.level, 'UNKNOWN');
    assert.equal(a.suppressGemAlert, false);
  });

  it('flags high tax, liquidity removal, and V3/V4 LP lock as unknown', () => {
    assert.equal(assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: goplus({ sellTaxPct: 15 }), honeypot: hp(), liquidityFlags: [] }).level, 'HIGH_RISK');
    assert.equal(assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: goplus(), honeypot: hp(), liquidityFlags: ['LIQUIDITY_DROP'] }).level, 'CRITICAL');
    const v4 = assessSecurity({ chain: 'bsc', poolKind: 'v4', goplus: goplus(), honeypot: hp(), liquidityFlags: [] });
    assert.equal(v4.checks.find((c) => c.id === 'lp_lock')?.status, 'UNKNOWN');
    assert.equal(v4.level, 'CAUTION');
  });

  it('softens mint and blacklist to a warning when ownership is renounced', () => {
    const a = assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: goplus({ mintable: true }), honeypot: hp(), liquidityFlags: [] });
    assert.equal(a.checks.find((c) => c.id === 'mintable')?.status, 'WARN');
    assert.equal(a.level, 'CAUTION');
  });

  it('marks Solana honeypot and tax checks UNKNOWN rather than passing them', () => {
    const a = assessSecurity({ chain: 'solana', poolKind: 'pair', goplus: parseSecurity({ mintable: { status: '0' }, freezable: { status: '0' }, balance_mutable_authority: { status: '0' } }, true), honeypot: null, liquidityFlags: [] });
    assert.equal(a.level, 'UNKNOWN');
  });
});

describe('security cache', () => {
  it('fetches once per TTL, respects the per-pass budget, and keeps old answers on failure', async () => {
    let now = NOW;
    let calls = 0;
    let fail = false;
    const cache = createSecurityCache({
      logger: silentLogger, now: () => now,
      fetchSecurity: async () => { calls += 1; if (fail) throw new Error('GoPlus HTTP 429'); return parseSecurity({ is_honeypot: '0' }, false); },
      fetchHoneypot: async () => parseHoneypot(LIVE_HONEYPOT),
    });
    assert.equal((await cache.get('bsc', '0xA', false)).at, null, 'no budget: nothing fetched');
    const first = await cache.get('bsc', '0xA', true);
    assert.equal(first.fetched, true);
    assert.equal((await cache.get('bsc', '0xa', true)).fetched, false, 'cached, address case ignored');
    now += 31 * 60_000;
    fail = true;
    const failed = await cache.get('bsc', '0xA', true);
    assert.equal(failed.goplus?.honeypot, false, 'previous GoPlus answer kept');
    assert.equal(calls, 2);
  });
});

describe('gem monitor with liquidity and security', () => {
  it('stores liquidity and security for each watched token and only fetches within budget', async () => {
    const { openDatabase } = await import('../src/storage/db.ts');
    const { createSwapStore } = await import('../src/gem/swap-store.ts');
    const { createSignalStore } = await import('../src/gem/signal-store.ts');
    const { createQualityStore } = await import('../src/gem/quality-store.ts');
    const { createGemMonitor } = await import('../src/gem/gem-monitor.ts');
    const db = openDatabase(':memory:');
    const swaps = createSwapStore(db);
    const quality = createQualityStore(db);
    const tokens = ['0x01', '0x02', '0x03', '0x04', '0x05'].map((t) => t.padEnd(42, '0'));
    for (const token of tokens) swaps.watch({ chain: 'bsc', token, pool: `0xp${token.slice(3)}`.slice(0, 42), poolKind: 'pair', symbol: null, reason: 't', addedAt: NOW - 7_200_000, expiresAt: NOW + 3_600_000 });
    swaps.saveCursor('bsc', { block: 1, coverageSince: NOW - 7_200_000 }, NOW);
    let fetches = 0;
    const monitor = createGemMonitor({
      chains: ['bsc'], swaps, signals: createSignalStore(db), logger: silentLogger, smartWallets: () => new Set(), now: () => NOW,
      fetchMarkets: async () => new Map(tokens.map((t) => [t, market()])),
      quality: {
        store: quality, settings: () => DEFAULT_GEM_SETTINGS, thbPerUsd: () => THB,
        security: createSecurityCache({ logger: silentLogger, now: () => NOW, fetchSecurity: async () => { fetches += 1; return null; }, fetchHoneypot: async () => null }),
        reserves: async () => new Map(),
      },
    });
    await monitor.tick();
    assert.equal(fetches, 3, 'three security lookups per pass');
    for (const t of tokens) {
      assert.equal(quality.latestLiquidity('bsc', t)?.report.liquiditySource, 'dexscreener');
      assert.equal(quality.latestSecurity('bsc', t)?.level, 'UNKNOWN', 'not looked up yet or no data = UNKNOWN, never clean');
    }
  });
});

describe('after a restart', () => {
  it('keeps the last stored security verdict until the token is looked up again', async () => {
    const { openDatabase } = await import('../src/storage/db.ts');
    const { createQualityStore } = await import('../src/gem/quality-store.ts');
    const { evaluateQuality } = await import('../src/gem/quality-evaluator.ts');
    const { detectAccumulation } = await import('../src/gem/accumulation.ts');
    const store = createQualityStore(openDatabase(':memory:'));
    const token = '0x00000000000000000000000000000000000000aa';
    const clean = assessSecurity({ chain: 'bsc', poolKind: 'pair', goplus: parseSecurity({ is_honeypot: '0', sell_tax: '0', owner_change_balance: '0', is_mintable: '0' }, false), honeypot: null, liquidityFlags: [] });
    store.recordSecurity('bsc', token, NOW - 5 * 60_000, clean);
    const deps = {
      store, settings: () => DEFAULT_GEM_SETTINGS, thbPerUsd: () => THB,
      security: createSecurityCache({ logger: silentLogger, now: () => NOW, fetchSecurity: async () => null, fetchHoneypot: async () => null }),
    };
    const ctx = {
      chain: 'bsc' as const, market: market(), reserves: null, asOf: NOW, allowSecurityFetch: false,
      watch: { chain: 'bsc', token, pool: '0xpair', poolKind: 'pair' as const, symbol: null, reason: 't', addedAt: NOW - 7_200_000, expiresAt: NOW + 3_600_000 },
      accumulation: detectAccumulation({ swaps: [], now: NOW, coverageSince: NOW - 7_200_000, smartWallets: new Set(), price: null }),
    };
    const r = await evaluateQuality(deps, ctx, silentLogger);
    assert.equal(r.security.level, clean.level, 'not a blanket UNKNOWN');
    assert.equal(store.latestSecurity('bsc', token)?.at, NOW - 5 * 60_000, 'nothing new recorded while pending');
  });
});

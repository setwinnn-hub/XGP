import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { silentLogger } from '../src/core/logger.ts';
import { detectAccumulation, type AccumulationInput } from '../src/gem/accumulation.ts';
import { clusterWallets } from '../src/gem/clustering.ts';
import { createGemMonitor } from '../src/gem/gem-monitor.ts';
import { createSignalStore } from '../src/gem/signal-store.ts';
import { createSwapStore, type SwapRow } from '../src/gem/swap-store.ts';
import { openDatabase } from '../src/storage/db.ts';

const NOW = 1_795_700_000_000;
const MIN = 60_000;
const TOKEN = '0x00000000000000000000000000000000000000aa';

let seq = 0;
function buy(wallet: string, minutesAgo: number, extra: Partial<SwapRow> = {}): SwapRow {
  seq += 1;
  return {
    chain: 'bsc', token: TOKEN, txHash: `0x${seq}`, side: 'BUY', wallet, tokenAmount: 100 + seq,
    block: 1_000_000 + seq, blockTime: NOW - minutesAgo * MIN, nonce: 50, feeGwei: 0.1, ...extra,
  };
}
const sell = (wallet: string, minutesAgo: number): SwapRow => ({ ...buy(wallet, minutesAgo), side: 'SELL' });

/** `n` distinct wallets buying spread across [fromMin, toMin) minutes ago. */
function buyers(prefix: string, n: number, fromMin: number, toMin: number): SwapRow[] {
  return Array.from({ length: n }, (_, i) => buy(`${prefix}${i}`, fromMin - ((fromMin - toMin) * (i + 0.5)) / n));
}

const input = (swaps: SwapRow[], overrides: Partial<AccumulationInput> = {}): AccumulationInput => ({
  swaps, now: NOW, coverageSince: NOW - 120 * MIN, smartWallets: new Set(), price: { changeM5Pct: 2, changeH1Pct: 10 }, ...overrides,
});

describe('clusterWallets', () => {
  it('never links wallets on a single shared block alone', () => {
    const rows = [buy('a', 1, { block: 7 }), buy('b', 1, { block: 7 })];
    assert.equal(clusterWallets(rows).clusters.length, 0);
  });

  it('links same-block buyers that are also brand-new wallets or share an unusual fee', () => {
    const fresh = [buy('a', 1, { block: 7, nonce: 0 }), buy('b', 1, { block: 7, nonce: 1 })];
    assert.deepEqual(clusterWallets(fresh).clusters.map((c) => c.wallets), [['a', 'b']]);
    const fee = [buy('c', 1, { block: 8, feeGwei: 1.2345, tokenAmount: 10 }), buy('d', 1, { block: 8, feeGwei: 1.2345, tokenAmount: 900 })];
    assert.deepEqual(clusterWallets(fee).clusters[0]!.evidence, ['same-block', 'same-unusual-fee']);
  });

  it('ignores common default fees and equal size alone, but links repeated co-buys', () => {
    const common = [buy('a', 1, { block: 7, feeGwei: 0.1, tokenAmount: 50 }), buy('b', 1, { block: 7, feeGwei: 0.1, tokenAmount: 50 })];
    assert.equal(clusterWallets(common).clusters.length, 0, 'default fee + same size is not enough');
    const twice = [buy('a', 3, { block: 7 }), buy('b', 3, { block: 7 }), buy('a', 1, { block: 9 }), buy('b', 1, { block: 9 })];
    assert.ok(clusterWallets(twice).clusters[0]!.evidence.includes('repeated-co-buys'));
  });
});

describe('detectAccumulation', () => {
  it('flags PRE_PUMP when independent buyers accelerate and price has not run (8 -> 22 example)', () => {
    const swaps = [...buyers('early', 8, 15, 5), ...buyers('late', 22, 5, 0), sell('x', 2)];
    const r = detectAccumulation(input(swaps));
    assert.equal(r.status, 'PRE_PUMP');
    assert.equal(r.metrics.independentBuyers5m, 22);
    assert.equal(r.metrics.baselinePer5m, 4);
    assert.equal(r.metrics.acceleration, 5.5);
  });

  it('says ALREADY_PUMPED for a big buyer count after the price already ran', () => {
    const swaps = [...buyers('a', 100, 15, 5), ...buyers('b', 400, 5, 0)];
    assert.equal(detectAccumulation(input(swaps, { price: { changeM5Pct: 5, changeH1Pct: 240 } })).status, 'ALREADY_PUMPED');
  });

  it('reports ACCUMULATING for steady independent buying with holders', () => {
    const swaps = [...buyers('a', 6, 15, 5), ...buyers('b', 4, 5, 0), sell('a0', 4)];
    const r = detectAccumulation(input(swaps));
    assert.equal(r.status, 'ACCUMULATING');
    assert.equal(r.metrics.netAccumulators15m, 9);
  });

  it('marks coordinated buying SUSPICIOUS instead of accumulation', () => {
    const bots = Array.from({ length: 6 }, (_, i) => buy(`bot${i}`, 2, { block: 42, nonce: 0 }));
    const swaps = [...buyers('a', 3, 15, 5), ...bots, ...buyers('b', 2, 5, 0)];
    const r = detectAccumulation(input(swaps));
    assert.equal(r.status, 'SUSPICIOUS');
    assert.equal(r.metrics.independentBuyers5m, 3, 'the six bots count as one buyer');
  });

  it('refuses to judge without 15 covered minutes or enough buys', () => {
    const swaps = [...buyers('a', 8, 15, 5), ...buyers('b', 22, 5, 0)];
    assert.equal(detectAccumulation(input(swaps, { coverageSince: NOW - 10 * MIN })).status, 'INSUFFICIENT_DATA');
    assert.equal(detectAccumulation(input(buyers('a', 3, 10, 0))).status, 'INSUFFICIENT_DATA');
  });

  it('counts followed wallets and says when price context is missing', () => {
    const swaps = [...buyers('a', 6, 15, 5), ...buyers('b', 4, 5, 0)];
    const r = detectAccumulation(input(swaps, { smartWallets: new Set(['b1']), price: null }));
    assert.equal(r.metrics.smartMoneyBuyers60m, 1);
    assert.ok(r.reasons.some((x) => x.includes('ไม่มีข้อมูลราคา')));
    assert.equal(r.confidence, 'MEDIUM');
  });
});

describe('gem monitor', () => {
  const market = (h1: number): MarketSnapshot => ({
    pairUrl: '', pairAddress: '0xpair', dexId: 'pancakeswap', priceUsd: 1, liquidityUsd: 1, marketCapUsd: 1, fdvUsd: 1,
    volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 }, priceChangePct: { m5: 1, h1, h24: null },
    pairCreatedAt: null, socials: 0, websites: 0, imageUrl: null,
  });

  it('stores a verdict when it changes, not every minute, and judges as of the last scan', async () => {
    const db = openDatabase(':memory:');
    const swaps = createSwapStore(db);
    const signals = createSignalStore(db);
    swaps.watch({ chain: 'bsc', token: TOKEN, pool: '0xpair', poolKind: 'pair', symbol: 'TKN', reason: 't', addedAt: NOW - 120 * MIN, expiresAt: NOW + 60 * MIN });
    swaps.saveCursor('bsc', { block: 1, coverageSince: NOW - 120 * MIN }, NOW);
    swaps.insertSwaps([...buyers('early', 8, 15, 5), ...buyers('late', 22, 5, 0)]);
    let now = NOW + 30_000; // the collector last finished at NOW
    let h1 = 10;
    const monitor = createGemMonitor({
      chains: ['bsc'], swaps, signals, logger: silentLogger, smartWallets: () => new Set(), now: () => now,
      fetchMarkets: async () => new Map([[TOKEN, market(h1)]]),
    });
    assert.equal(await monitor.tick(), 1);
    assert.equal(signals.latest('bsc', TOKEN)?.status, 'PRE_PUMP');
    assert.equal(signals.latest('bsc', TOKEN)?.at, NOW, 'as of the collector, not the wall clock');
    now += 60_000;
    assert.equal(await monitor.tick(), 0, 'same verdict is not stored again');
    h1 = 300;
    assert.equal(await monitor.tick(), 1);
    assert.equal(signals.latest('bsc', TOKEN)?.status, 'ALREADY_PUMPED');
    assert.equal(signals.history('bsc', TOKEN, 10).length, 2);
  });

  it('keeps working without market data', async () => {
    const db = openDatabase(':memory:');
    const swaps = createSwapStore(db);
    const signals = createSignalStore(db);
    swaps.watch({ chain: 'bsc', token: TOKEN, pool: '0xpair', poolKind: 'pair', symbol: null, reason: 't', addedAt: NOW - 120 * MIN, expiresAt: NOW + 60 * MIN });
    swaps.saveCursor('bsc', { block: 1, coverageSince: NOW - 120 * MIN }, NOW);
    const monitor = createGemMonitor({
      chains: ['bsc'], swaps, signals, logger: silentLogger, smartWallets: () => new Set(), now: () => NOW,
      fetchMarkets: async () => { throw new Error('DexScreener HTTP 429'); },
    });
    assert.equal(await monitor.tick(), 1);
    assert.equal(signals.latest('bsc', TOKEN)?.status, 'INSUFFICIENT_DATA');
  });
});

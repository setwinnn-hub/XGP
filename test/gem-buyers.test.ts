import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toEventSelector, type PublicClient } from 'viem';
import { findEvmChain } from '../src/chains/evm/chains.ts';
import { silentLogger } from '../src/core/logger.ts';
import { buyerWindows } from '../src/gem/buyer-stats.ts';
import { createSwapCollector, tokenCoverageSince } from '../src/gem/swap-collector.ts';
import { netSwaps, type PoolTransfer } from '../src/gem/swap-netting.ts';
import { createSwapStore, type SwapRow, type WatchEntry } from '../src/gem/swap-store.ts';
import { watchFor } from '../src/gem/watch-policy.ts';
import { openDatabase } from '../src/storage/db.ts';

const NOW = 1_795_700_000_000;
const MIN = 60_000;
const BSC = findEvmChain('bsc')!;
const TOKEN = '0x00000000000000000000000000000000000000aa';
const PAIR = '0x00000000000000000000000000000000000000bb';
const POOL_ID = `0x${'cd'.repeat(32)}`;
const V4_MANAGER = BSC.factories.find((f) => f.kind === 'uniswap-v4')!.address.toLowerCase();

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const SWAP_V2 = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_V4 = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

const swap = (wallet: string, side: 'BUY' | 'SELL', minutesAgo: number, tx = `${wallet}-${minutesAgo}-${side}`): SwapRow => ({
  chain: 'bsc', token: TOKEN, txHash: tx, side, wallet, tokenAmount: 10, block: 1, blockTime: NOW - minutesAgo * MIN,
});

const watch = (overrides: Partial<WatchEntry> = {}): WatchEntry => ({
  chain: 'bsc', token: TOKEN, pool: PAIR, poolKind: 'pair', symbol: 'TKN', reason: 'test', addedAt: NOW - 120 * MIN, expiresAt: NOW + 60 * MIN, ...overrides,
});

describe('netSwaps', () => {
  const t = (txHash: string, outOfPool: bigint): PoolTransfer => ({ token: TOKEN, txHash, block: 1, outOfPool });

  it('turns pool outflow into a BUY and inflow into a SELL', () => {
    const result = netSwaps([t('a', 100n), t('b', -40n)], new Set(['a', 'b']));
    assert.deepEqual(result.map((s) => [s.txHash, s.side, s.raw]), [['a', 'BUY', 100n], ['b', 'SELL', 40n]]);
  });

  it('drops transfers without a Swap event in the same tx (liquidity add/remove)', () => {
    assert.deepEqual(netSwaps([t('lp', 500n)], new Set()), []);
  });

  it('drops arbitrage that takes and returns the same amount, keeps a real net position', () => {
    const arb = [t('arb', 1_000n), t('arb', -995n)];
    const real = [t('real', 1_000n), t('real', -500n)];
    const result = netSwaps([...arb, ...real], new Set(['arb', 'real']));
    assert.deepEqual(result.map((s) => [s.txHash, s.side, s.raw]), [['real', 'BUY', 500n]]);
  });
});

describe('buyerWindows', () => {
  it('counts each wallet once per window and separates new, returning and multi-buy wallets', () => {
    const swaps = [
      swap('old', 'BUY', 30), // bought before the 5-minute window
      swap('old', 'BUY', 2),
      swap('fresh', 'BUY', 3),
      swap('fresh', 'BUY', 1.5),
      swap('seller', 'SELL', 2),
    ];
    const w5 = buyerWindows(swaps, NOW, NOW - 120 * MIN).find((w) => w.minutes === 5)!;
    assert.equal(w5.buys, 3);
    assert.equal(w5.uniqueBuyers, 2);
    assert.equal(w5.newBuyers, 1);
    assert.equal(w5.returningBuyers, 1);
    assert.equal(w5.multiBuyWallets, 1);
    assert.equal(w5.uniqueSellers, 1);
    assert.equal(w5.buySellRatio, 3);
    assert.equal(w5.complete, true);
  });

  it('computes growth against the previous window and null when that window is not covered', () => {
    const swaps = [swap('a', 'BUY', 7), swap('b', 'BUY', 4), swap('c', 'BUY', 3), swap('d', 'BUY', 1)];
    const covered = buyerWindows(swaps, NOW, NOW - 120 * MIN).find((w) => w.minutes === 5)!;
    assert.equal(covered.previousUniqueBuyers, 1);
    assert.equal(covered.uniqueBuyersGrowthPct, 200);
    const partial = buyerWindows(swaps, NOW, NOW - 8 * MIN);
    assert.equal(partial.find((w) => w.minutes === 5)!.uniqueBuyersGrowthPct, null);
    assert.equal(partial.find((w) => w.minutes === 15)!.complete, false);
    assert.equal(partial.find((w) => w.minutes === 5)!.complete, true);
  });

  it('reports no ratio when there were no sells', () => {
    assert.equal(buyerWindows([swap('a', 'BUY', 0.5)], NOW, 0)[0]!.buySellRatio, null);
  });
});

describe('swap store', () => {
  it('upserts watches, extends expiry, hides expired ones and ignores duplicate swaps', () => {
    const store = createSwapStore(openDatabase(':memory:'));
    assert.equal(store.watch(watch()), true);
    assert.equal(store.watch(watch({ expiresAt: NOW + 300 * MIN, addedAt: NOW })), false);
    const saved = store.findWatch('bsc', TOKEN)!;
    assert.equal(saved.expiresAt, NOW + 300 * MIN);
    assert.equal(saved.addedAt, NOW - 120 * MIN, 'the original start is kept');
    assert.equal(store.activeWatches('bsc', NOW + 301 * MIN).length, 0);
    const row = swap('a', 'BUY', 1, '0xtx');
    assert.equal(store.insertSwaps([row, row]), 1);
    assert.deepEqual(store.swaps('bsc', TOKEN, 0), [row]);
    store.saveCursor('bsc', { block: 5, coverageSince: NOW }, NOW);
    assert.deepEqual(store.cursor('bsc'), { block: 5, coverageSince: NOW });
  });
});

describe('watchFor', () => {
  const ref = { chain: 'bsc' as const, token: TOKEN, symbol: 'TKN', name: null };
  const m = (pairAddress: string | null, marketCapUsd: number | null = null, fdvUsd: number | null = null) => ({ pairAddress, marketCapUsd, fdvUsd });
  it('watches V2/V3 pair contracts and V4 pool ids, never Solana or unknown pools', () => {
    assert.equal(watchFor(ref, m(PAIR), NOW)?.poolKind, 'pair');
    assert.equal(watchFor(ref, m(POOL_ID), NOW)?.poolKind, 'v4');
    assert.equal(watchFor(ref, m('not-a-pool'), NOW), null);
    assert.equal(watchFor(ref, m(null), NOW), null);
    assert.equal(watchFor(ref, null, NOW), null);
    assert.equal(watchFor({ ...ref, chain: 'solana' }, m(PAIR), NOW), null);
  });

  it('skips tokens already far above the gem range, keeps tokens without a price yet', () => {
    assert.equal(watchFor(ref, m(PAIR, 5_000_000_000), NOW), null, 'WBTC-sized');
    assert.equal(watchFor(ref, m(PAIR, null, 2_000_000), NOW), null, 'FDV used when market cap is missing');
    assert.notEqual(watchFor(ref, m(PAIR, 20_000), NOW), null);
  });

  it('uses the later of watch start and chain coverage', () => {
    assert.equal(tokenCoverageSince(watch({ addedAt: 50 }), 10), 50);
    assert.equal(tokenCoverageSince(watch({ addedAt: 5 }), 10), 10);
  });
});

// ---- collector against a fake RPC client ----

const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const topicOf = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
const E18 = 10n ** 18n;

interface FakeLog { address: string; topics: (string | null)[]; data: string; transactionHash: string; blockNumber: string }

function fakeClient(logs: FakeLog[], signers: Record<string, string>, calls: { count: number; fail?: boolean }): PublicClient {
  const matches = (l: FakeLog, filter: { address: string | string[]; topics: (string | string[] | null)[] }): boolean => {
    const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
    if (!addresses.includes(l.address)) return false;
    return filter.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i] ?? '') : t === l.topics[i]));
  };
  const client = {
    request: async ({ params }: { params: [{ address: string | string[]; topics: (string | string[] | null)[] }] }) => {
      calls.count += 1;
      if (calls.fail) throw new Error('Rate limit exceeded');
      return logs.filter((l) => matches(l, params[0]));
    },
    getLogs: async ({ address }: { address: string[] }) =>
      logs.filter((l) => address.map((a) => a.toLowerCase()).includes(l.address)),
    multicall: async () => [{ status: 'success', result: 18 }],
    getTransaction: async ({ hash }: { hash: string }) => ({ from: signers[hash] }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_795_700_000n + blockNumber }),
  };
  return client as unknown as PublicClient;
}

const transfer = (tx: string, block: number, from: string, to: string, amount: bigint): FakeLog => ({
  address: TOKEN, topics: [TRANSFER, topicOf(from), topicOf(to)], data: word(amount), transactionHash: tx, blockNumber: `0x${block.toString(16)}`,
});
const pairSwap = (tx: string, block: number): FakeLog => ({
  address: PAIR, topics: [SWAP_V2, topicOf(PAIR), topicOf(PAIR)], data: '0x', transactionHash: tx, blockNumber: `0x${block.toString(16)}`,
});
const ROUTER = '0x00000000000000000000000000000000000000cc';

describe('swap collector', () => {
  it('records netted buys and sells by the signing wallet, skipping arbitrage and liquidity moves', async () => {
    const logs = [
      transfer('0xbuy', 101, PAIR, ROUTER, 1_000n * E18), pairSwap('0xbuy', 101),
      transfer('0xsell', 105, ROUTER, PAIR, 400n * E18), pairSwap('0xsell', 105),
      transfer('0xarb', 106, PAIR, ROUTER, 500n * E18), transfer('0xarb', 106, ROUTER, PAIR, 500n * E18), pairSwap('0xarb', 106),
      transfer('0xlp', 107, PAIR, ROUTER, 300n * E18),
    ];
    const signers = { '0xbuy': '0xW1', '0xsell': '0xW2', '0xarb': '0xBOT' };
    const collector = createSwapCollector({ chain: BSC, store: createSwapStore(openDatabase(':memory:')), logger: silentLogger });
    const rows = await collector.collectRange(fakeClient(logs, signers, { count: 0 }), [watch()], 100n, 110n);
    assert.deepEqual(rows.map((r) => [r.txHash, r.side, r.wallet, r.tokenAmount, r.blockTime]), [
      ['0xbuy', 'BUY', '0xw1', 1_000, (1_795_700_000 + 101) * 1000],
      ['0xsell', 'SELL', '0xw2', 400, (1_795_700_000 + 105) * 1000],
    ]);
  });

  it('reads Uniswap V4 pools through the PoolManager and their pool id', async () => {
    const logs = [
      transfer('0xv4', 103, V4_MANAGER, ROUTER, 7n * E18),
      { address: V4_MANAGER, topics: [SWAP_V4, POOL_ID, topicOf(ROUTER)], data: '0x', transactionHash: '0xv4', blockNumber: '0x67' },
    ];
    const collector = createSwapCollector({ chain: BSC, store: createSwapStore(openDatabase(':memory:')), logger: silentLogger });
    const rows = await collector.collectRange(fakeClient(logs, { '0xv4': '0xW3' }, { count: 0 }), [watch({ pool: POOL_ID, poolKind: 'v4' })], 100n, 110n);
    assert.deepEqual(rows.map((r) => [r.side, r.wallet, r.tokenAmount]), [['BUY', '0xw3', 7]]);
  });

  it('stores swaps and moves the cursor on heads; pauses and keeps the cursor after a failure', async () => {
    let now = NOW;
    const store = createSwapStore(openDatabase(':memory:'));
    store.watch(watch());
    store.saveCursor('bsc', { block: 99, coverageSince: NOW - 60 * MIN }, NOW);
    const calls = { count: 0, fail: false };
    const client = fakeClient([transfer('0xbuy', 101, PAIR, ROUTER, E18), pairSwap('0xbuy', 101)], { '0xbuy': '0xW1' }, calls);
    const collector = createSwapCollector({ chain: BSC, store, logger: silentLogger, now: () => now });
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

    collector.onHead(client, 111n); // reads up to head - 2
    await settle();
    assert.equal(store.swaps('bsc', TOKEN, 0).length, 1);
    assert.deepEqual(store.cursor('bsc'), { block: 109, coverageSince: NOW - 60 * MIN });

    calls.fail = true;
    now += 10_000;
    collector.onHead(client, 130n);
    await settle();
    assert.equal(store.cursor('bsc')!.block, 109, 'failed range is read again later');
    const before = calls.count;
    now += 10_000; // still inside the 15 s back-off
    collector.onHead(client, 131n);
    await settle();
    assert.equal(calls.count, before, 'no requests while paused');
  });

  it('never puts more than 10 addresses in one log filter (free-RPC limit)', async () => {
    const seen: number[] = [];
    const tokens = Array.from({ length: 23 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    const many = tokens.map((token, i) => watch({ token, pool: `0x${(i + 100).toString(16).padStart(40, '0')}` }));
    const client = {
      request: async ({ params }: { params: [{ address: string | string[] }] }) => {
        seen.push(Array.isArray(params[0].address) ? params[0].address.length : 1);
        return [];
      },
    } as unknown as PublicClient;
    const collector = createSwapCollector({ chain: BSC, store: createSwapStore(openDatabase(':memory:')), logger: silentLogger });
    await collector.collectRange(client, many, 1n, 2n);
    assert.ok(seen.length >= 9, `expected 3 batches x 3 queries, got ${seen.length}`);
    assert.ok(Math.max(...seen) <= 10);
  });

  it('restarts coverage when blocks had to be skipped', async () => {
    const store = createSwapStore(openDatabase(':memory:'));
    store.watch(watch());
    store.saveCursor('bsc', { block: 1, coverageSince: NOW - 60 * MIN }, NOW);
    const collector = createSwapCollector({ chain: BSC, store, logger: silentLogger, now: () => NOW });
    collector.onHead(fakeClient([], {}, { count: 0 }), 10_000n);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(store.cursor('bsc'), { block: 9_998, coverageSince: NOW });
  });
});

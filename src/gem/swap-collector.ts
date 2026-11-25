import { parseAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from 'viem';
import type { EvmChainConfig } from '../chains/evm/chains.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import { nextBlockRange } from '../chains/evm/block-range.ts';
import { netSwaps, type PoolTransfer } from './swap-netting.ts';
import type { SwapRow, SwapStore, WatchEntry } from './swap-store.ts';

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const SWAP_V2 = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_V3 = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)');
const SWAP_V3_PANCAKE = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
const SWAP_V4 = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const DECIMALS = parseAbiItem('function decimals() view returns (uint8)');
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Blocks per scan; a longer outage resets coverage instead of re-reading history. */
const MAX_BLOCKS = 300n;
const MIN_SCAN_GAP_MS = 5_000;
/** After failures (usually free-RPC rate limits) back off so pair detection keeps its share. */
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MAX_WATCHES = 40;
const TX_CONCURRENCY = 4;
/** Free PublicNode endpoints reject eth_getLogs with more than 10 addresses. */
const MAX_FILTER_ADDRESSES = 10;

const topicAddress = (a: string): Hex => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;

interface Raw {
  readonly address: string;
  readonly topics: readonly (string | null)[];
  readonly data: string;
  readonly transactionHash: string | null;
  readonly blockNumber: bigint | null;
}

export interface SwapCollectorDeps {
  readonly chain: EvmChainConfig;
  readonly store: SwapStore;
  readonly logger: Logger;
  /**
   * Own HTTP client for the collector's reads. Keeps its load off the WebSocket that pair
   * detection uses (free WS endpoints cap in-flight requests per connection).
   */
  readonly rpc?: PublicClient;
  readonly now?: () => number;
}

export interface SwapCollector {
  onHead(client: PublicClient, head: bigint): void;
  /** Reads a block range for the given watches without storing anything (backfill, checks). */
  collectRange(client: PublicClient, watches: readonly WatchEntry[], from: bigint, to: bigint): Promise<SwapRow[]>;
}

/** Per-token coverage: a token added after the chain cursor started is complete from its own start. */
export function tokenCoverageSince(watch: WatchEntry, chainCoverageSince: number): number {
  return Math.max(watch.addedAt, chainCoverageSince);
}

/**
 * Collects buys and sells of watched tokens on one EVM chain from pool logs, attributing
 * each to the wallet that signed the transaction. Address-filtered queries only, which the
 * free public RPCs accept.
 */
export function createSwapCollector(deps: SwapCollectorDeps): SwapCollector {
  const { chain, store } = deps;
  const now = deps.now ?? Date.now;
  const logger = deps.logger.child({ source: `gem:${chain.id}` });
  const poolManager = chain.factories.find((f) => f.kind === 'uniswap-v4')?.address.toLowerCase() ?? null;
  const decimals = new Map<string, number>();
  const blockTimes = new Map<bigint, number>();
  let latestHead: bigint | null = null;
  let running = false;
  let lastScanAt = 0;
  let failures = 0;
  let pausedUntil = 0;

  const holderOf = (w: WatchEntry): string | null => (w.poolKind === 'v4' ? poolManager : w.pool.toLowerCase());

  const loadDecimals = async (client: PublicClient, tokens: readonly string[]): Promise<void> => {
    const missing = tokens.filter((t) => !decimals.has(t));
    if (missing.length === 0) return;
    const results = await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true,
      contracts: missing.map((t) => ({ address: t as Address, abi: [DECIMALS], functionName: 'decimals' as const })),
    });
    missing.forEach((t, i) => { const r = results[i]; if (r?.status === 'success') decimals.set(t, Number(r.result)); });
  };

  const blockTime = async (client: PublicClient, block: bigint): Promise<number> => {
    const cached = blockTimes.get(block);
    if (cached !== undefined) return cached;
    const ms = Number((await client.getBlock({ blockNumber: block })).timestamp) * 1000;
    blockTimes.set(block, ms);
    if (blockTimes.size > 2_000) blockTimes.delete(blockTimes.keys().next().value ?? block);
    return ms;
  };

  const readBatch = async (client: PublicClient, watches: readonly WatchEntry[], from: bigint, to: bigint): Promise<{ transfers: PoolTransfer[]; swapTxs: Set<string> }> => {
    const tokens = [...new Set(watches.map((w) => w.token.toLowerCase()))] as Address[];
    const holders = [...new Set(watches.map(holderOf).filter((h): h is string => h !== null))];
    const pairs = watches.filter((w) => w.poolKind === 'pair').map((w) => w.pool as Address);
    const v4Ids = watches.filter((w) => w.poolKind === 'v4').map((w) => w.pool as Hex);
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` } as const;
    const logsOf = (filter: Record<string, unknown>): Promise<Raw[]> =>
      client.request({ method: 'eth_getLogs', params: [{ ...filter, ...range }] } as never) as Promise<Raw[]>;
    // One query at a time: free endpoints reject bursts ("Request exceeds defined limit").
    const outs = await logsOf({ address: tokens, topics: [TRANSFER, holders.map(topicAddress)] });
    const ins = await logsOf({ address: tokens, topics: [TRANSFER, null, holders.map(topicAddress)] });
    const pairSwaps = pairs.length > 0 ? await logsOf({ address: pairs, topics: [[SWAP_V2, SWAP_V3, SWAP_V3_PANCAKE]] }) : [];
    const v4Swaps = v4Ids.length > 0 && poolManager ? await logsOf({ address: poolManager, topics: [SWAP_V4, v4Ids] }) : [];
    const watchHolders = new Map(watches.map((w) => [`${w.token.toLowerCase()}:${holderOf(w)}`, true]));
    const transfer = (l: Raw, sign: 1n | -1n): PoolTransfer[] => {
      const holder = `0x${String(sign === 1n ? l.topics[1] : l.topics[2]).slice(26)}`.toLowerCase();
      if (!watchHolders.has(`${l.address.toLowerCase()}:${holder}`) || !l.transactionHash || l.blockNumber === null) return [];
      return [{ token: l.address.toLowerCase(), txHash: l.transactionHash, block: Number(BigInt(l.blockNumber)), outOfPool: sign * BigInt(l.data.slice(0, 66)) }];
    };
    return {
      transfers: [...outs.flatMap((l) => transfer(l, 1n)), ...ins.flatMap((l) => transfer(l, -1n))],
      swapTxs: new Set([...pairSwaps, ...v4Swaps].flatMap((l) => (l.transactionHash ? [l.transactionHash] : []))),
    };
  };

  /** Reads in batches of at most 10 watches so every filter stays within the free-RPC address limit. */
  const readLogs = async (client: PublicClient, watches: readonly WatchEntry[], from: bigint, to: bigint): Promise<{ transfers: PoolTransfer[]; swapTxs: Set<string> }> => {
    let transfers: PoolTransfer[] = [];
    let swapTxs = new Set<string>();
    for (let i = 0; i < watches.length; i += MAX_FILTER_ADDRESSES) {
      const batch = await readBatch(client, watches.slice(i, i + MAX_FILTER_ADDRESSES), from, to);
      transfers = [...transfers, ...batch.transfers];
      swapTxs = new Set([...swapTxs, ...batch.swapTxs]);
    }
    return { transfers, swapTxs };
  };

  const toRows = async (client: PublicClient, watches: readonly WatchEntry[], from: bigint, to: bigint): Promise<SwapRow[]> => {
    const { transfers, swapTxs } = await readLogs(client, watches, from, to);
    const swaps = netSwaps(transfers, swapTxs);
    if (swaps.length === 0) return [];
    await loadDecimals(client, [...new Set(swaps.map((s) => s.token))]);
    const signers = new Map<string, { from: string; nonce: number; feeGwei: number | null }>();
    const hashes = [...new Set(swaps.map((s) => s.txHash))];
    for (let i = 0; i < hashes.length; i += TX_CONCURRENCY) {
      await Promise.all(hashes.slice(i, i + TX_CONCURRENCY).map(async (h) => {
        const tx = await client.getTransaction({ hash: h as Hex });
        const fee = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? null;
        signers.set(h, { from: tx.from.toLowerCase(), nonce: Number(tx.nonce), feeGwei: fee === null ? null : Number(fee) / 1e9 });
      }));
    }
    const tokenByLower = new Map(watches.map((w) => [w.token.toLowerCase(), w.token]));
    // Two block lookups per range; blocks in between are interpolated (seconds of error, far fewer calls).
    const [fromMs, toMs] = [await blockTime(client, from), await blockTime(client, to)];
    const timeOf = (block: number): number =>
      to === from ? toMs : Math.round(fromMs + ((block - Number(from)) * (toMs - fromMs)) / Number(to - from));
    return swaps.map((s) => ({
      chain: chain.id, token: tokenByLower.get(s.token) ?? s.token, txHash: s.txHash, side: s.side,
      wallet: signers.get(s.txHash)?.from ?? 'unknown', nonce: signers.get(s.txHash)?.nonce ?? null, feeGwei: signers.get(s.txHash)?.feeGwei ?? null, tokenAmount: Number(s.raw) / 10 ** (decimals.get(s.token) ?? 18),
      block: s.block, blockTime: timeOf(s.block),
    }));
  };

  const scan = async (client: PublicClient): Promise<void> => {
    if (latestHead === null) return;
    // Two blocks behind the head: the HTTP endpoint can lag the WebSocket that announced the head.
    const target = latestHead - 2n;
    const watches = store.activeWatches(chain.id, now()).slice(0, MAX_WATCHES);
    const saved = store.cursor(chain.id);
    if (watches.length === 0) {
      // Nothing to read; keep the cursor at the head so a new watch starts without a false gap.
      store.saveCursor(chain.id, { block: Number(target), coverageSince: saved?.coverageSince ?? now() }, now());
      return;
    }
    const range = nextBlockRange(saved ? BigInt(saved.block) : null, target, MAX_BLOCKS);
    if (!range) return;
    // Skipped blocks (outage) mean earlier windows are incomplete: restart coverage now.
    const coverageSince = !saved || range.skipped > 0n ? now() : saved.coverageSince;
    if (range.skipped > 0n) logger.warn('swap collection gap, coverage restarted', { skippedBlocks: Number(range.skipped) });
    const rows = await toRows(client, watches, range.from, range.to);
    const added = store.insertSwaps(rows);
    store.saveCursor(chain.id, { block: Number(range.to), coverageSince }, now());
    if (added > 0) logger.debug('swaps recorded', { added, blocks: Number(range.to - range.from + 1n) });
  };

  return {
    collectRange: toRows,
    onHead(headClient, head) {
      const client = deps.rpc ?? headClient;
      if (latestHead === null || head > latestHead) latestHead = head;
      if (running || now() < pausedUntil || now() - lastScanAt < MIN_SCAN_GAP_MS) return;
      running = true;
      lastScanAt = now();
      scan(client)
        .then(() => { failures = 0; })
        .catch((error: unknown) => {
          failures += 1;
          const pauseMs = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
          pausedUntil = now() + pauseMs;
          // The cursor did not move, so the same blocks are read after the pause (no data lost).
          logger.warn('swap scan failed, pausing', { error: errorMessage(error).split('\n')[0], failures, pauseSec: pauseMs / 1000 });
        })
        .finally(() => { running = false; });
    },
  };
}

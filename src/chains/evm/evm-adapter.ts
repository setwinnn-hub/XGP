import { createPublicClient, webSocket, type AbiEvent, type Address, type Log, type PublicClient } from 'viem';
import type { Adapter, AdapterDeps } from '../../core/adapter.ts';
import { errorMessage } from '../../core/logger.ts';
import { sleep } from '../../core/util.ts';
import { ERC20_METADATA_ABI } from './abis.ts';
import { nextBlockRange } from './block-range.ts';
import type { DexFactory, EvmChainConfig } from './chains.ts';
import { factoryEventFor } from './factory-events.ts';
import { normalizePairLog, pairSides, type TokenMeta } from './normalize.ts';
import type { EvmWalletScanner } from './wallet-scanner.ts';
import type { SwapCollector } from '../../gem/swap-collector.ts';

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const META_TIMEOUT_MS = 3_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const BLOCK_TIME_CACHE = 256;
/** Largest catch-up range per eth_getLogs call after an outage. */
const MAX_SCAN_BLOCKS = 500n;
const INDEX_LAG_RETRY_MS = 1_500;
/** A failed scan is retried after this long rather than on the next block head. */
const SCAN_RETRY_MS = 2_000;

export interface EvmAdapterDeps extends AdapterDeps {
  readonly chain: EvmChainConfig;
  readonly wsUrl: string;
  readonly onChainTime: (key: string, chainMs: number) => void;
  /** Followed-wallet trades share this connection's block heads. */
  readonly walletScanner?: EvmWalletScanner;
  /** Buys/sells of watched tokens (Early Gem) share the same heads. */
  readonly swapCollector?: SwapCollector;
}

type Client = ReturnType<typeof createClient>;

function createClient(wsUrl: string) {
  return createPublicClient({
    transport: webSocket(wsUrl, { keepAlive: { interval: 15_000 }, reconnect: { attempts: 5, delay: 2_000 }, timeout: 10_000 }),
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchTokenMeta(client: Client, token: Address): Promise<TokenMeta> {
  const results = await withTimeout(
    client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        { address: token, abi: ERC20_METADATA_ABI, functionName: 'name' },
        { address: token, abi: ERC20_METADATA_ABI, functionName: 'symbol' },
      ],
    }),
    META_TIMEOUT_MS,
  );
  const text = (r: (typeof results)[number] | undefined): string | null =>
    r?.status === 'success' && typeof r.result === 'string' ? r.result.slice(0, 80) : null;
  return { name: text(results[0]), symbol: text(results[1]) };
}

function uniqueEvents(chain: EvmChainConfig): AbiEvent[] {
  const byKind = new Map(chain.factories.map((f) => [f.kind, factoryEventFor(f.kind)] as const));
  return [...byKind.values()];
}

/**
 * New pairs/pools on one EVM chain. A WebSocket newHeads subscription is the trigger and
 * heartbeat; each new head runs one eth_getLogs over every block since the last processed
 * one. Unlike per-event log subscriptions this cannot silently lose logs across reconnects,
 * and it catches up on blocks missed during an outage.
 */
export function createEvmAdapter(deps: EvmAdapterDeps): Adapter {
  const { chain, health } = deps;
  const name = `evm:${chain.id}`;
  const logger = deps.logger.child({ source: name });
  health.register(name, chain.staleBlockMs);

  const factoryByAddress = new Map(chain.factories.map((f) => [f.address.toLowerCase(), f] as const));
  const addresses = chain.factories.map((f) => f.address);
  const events = uniqueEvents(chain);

  let client: Client | null = null;
  let unwatchHeads: (() => void) | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let stopped = true;
  let rebuilding = false;
  let lastConnectAt = 0;
  let lastProcessed: bigint | null = null;
  let latestHead: bigint | null = null;
  let scanning = false;
  let retryTimer: NodeJS.Timeout | null = null;
  const blockTimes = new Map<bigint, number>();

  const resolveBlockTime = async (c: Client, key: string, blockNumber: bigint): Promise<void> => {
    const cached = blockTimes.get(blockNumber);
    if (cached !== undefined) return deps.onChainTime(key, cached);
    const block = await c.getBlock({ blockNumber });
    const ms = Number(block.timestamp) * 1000;
    blockTimes.set(blockNumber, ms);
    if (blockTimes.size > BLOCK_TIME_CACHE) blockTimes.delete(blockTimes.keys().next().value ?? blockNumber);
    deps.onChainTime(key, ms);
  };

  const handleLog = async (c: Client, log: Log, detectedAt: number): Promise<void> => {
    const factory: DexFactory | undefined = factoryByAddress.get(log.address.toLowerCase());
    if (!factory || log.removed || !log.transactionHash || log.logIndex === null || log.blockNumber === null) return;
    const args = ('args' in log ? log.args : {}) as Readonly<Record<string, unknown>>;
    const base = { chain, factory, args, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, detectedAt };
    const sides = pairSides(base);
    if (!sides) return;
    const meta = await fetchTokenMeta(c, sides.token as Address).catch((error: unknown) => {
      logger.debug('token metadata failed', { token: sides.token, error: errorMessage(error) });
      return { name: null, symbol: null };
    });
    const event = normalizePairLog(base, meta);
    if (!event || !deps.ingest(name, event)) return;
    resolveBlockTime(c, event.key, log.blockNumber).catch((error: unknown) =>
      logger.debug('block time lookup failed', { error: errorMessage(error) }));
  };

  /**
   * eth_getLogs for a range. Load-balanced RPCs can announce a head before their log index
   * has it ("block range extends beyond current head"). Then scan up to head-1 now and pick
   * up the newest block on the next pass, instead of failing the whole range repeatedly.
   */
  const getLogsTolerant = async (c: Client, from: bigint, to: bigint): Promise<{ logs: Log[]; to: bigint }> => {
    try {
      return { logs: (await c.getLogs({ address: addresses, events, fromBlock: from, toBlock: to })) as Log[], to };
    } catch (error: unknown) {
      if (to <= from) {
        // Single newest block not indexed yet: give the node a moment, then try once more.
        await sleep(INDEX_LAG_RETRY_MS);
        return { logs: (await c.getLogs({ address: addresses, events, fromBlock: from, toBlock: to })) as Log[], to };
      }
      logger.debug('getLogs failed for newest block, scanning one block behind', { error: errorMessage(error) });
      return { logs: (await c.getLogs({ address: addresses, events, fromBlock: from, toBlock: to - 1n })) as Log[], to: to - 1n };
    }
  };

  /** Scans from the last processed block to the latest head; re-runs while new heads arrived. */
  const scan = async (c: Client): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      while (client === c && latestHead !== null) {
        const range = nextBlockRange(lastProcessed, latestHead, MAX_SCAN_BLOCKS);
        if (!range) break;
        if (range.skipped > 0n) logger.warn('outage too long, skipped blocks', { skipped: Number(range.skipped) });
        const scanned = await getLogsTolerant(c, range.from, range.to);
        const logs = scanned.logs;
        const detectedAt = Date.now();
        lastProcessed = scanned.to;
        for (const log of logs) {
          handleLog(c, log as Log, detectedAt).catch((error: unknown) =>
            logger.error('pair log handling failed', { error: errorMessage(error) }));
        }
      }
    } catch (error: unknown) {
      // lastProcessed is unchanged: retry the same range shortly instead of waiting a whole
      // block (12 s on Ethereum) for the next head; that wait was the main alert delay.
      logger.warn('getLogs failed, retrying', { error: errorMessage(error), retryMs: SCAN_RETRY_MS });
      scheduleRetry(c);
    } finally {
      scanning = false;
    }
  };

  const scheduleRetry = (c: Client): void => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (client === c && !stopped) void scan(c);
    }, SCAN_RETRY_MS);
  };

  const connect = (): void => {
    const c = createClient(deps.wsUrl);
    client = c;
    lastConnectAt = Date.now();
    unwatchHeads = c.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (head) => {
        health.beat(name);
        if (latestHead === null || head > latestHead) latestHead = head;
        void scan(c);
        deps.walletScanner?.onHead(c as unknown as PublicClient, head);
        deps.swapCollector?.onHead(c as unknown as PublicClient, head);
      },
      onError: (error) => logger.warn('newHeads subscription error', { error: errorMessage(error) }),
    });
    logger.info('subscribed', { factories: chain.factories.map((f) => f.name), resumeFrom: lastProcessed?.toString() ?? 'head' });
  };

  const disconnect = async (): Promise<void> => {
    unwatchHeads?.();
    unwatchHeads = null;
    const old = client;
    client = null;
    if (!old) return;
    // viem caches sockets per URL; closing removes the dead socket from its cache.
    const rpc = await old.transport.getRpcClient().catch(() => null);
    rpc?.close();
  };

  const checkStale = (): void => {
    if (stopped || rebuilding) return;
    const status = health.snapshot().find((s) => s.name === name);
    // Silence is measured from the last block or the last (re)connect, whichever is later,
    // so a fresh connection gets a full window and a source that never connects is caught.
    const since = Math.max(status?.lastBeatAt ?? 0, lastConnectAt);
    if (Date.now() - since <= chain.staleBlockMs) return;
    logger.warn('no new blocks, rebuilding connection', { silentMs: Date.now() - since });
    health.countReconnect(name);
    rebuilding = true;
    disconnect()
      .catch((error: unknown) => logger.warn('disconnect failed', { error: errorMessage(error) }))
      .finally(() => {
        rebuilding = false;
        if (!stopped) connect();
      });
  };

  return {
    name,
    start() {
      stopped = false;
      connect();
      watchdog = setInterval(checkStale, WATCHDOG_INTERVAL_MS);
    },
    stop() {
      stopped = true;
      if (watchdog) clearInterval(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      void disconnect();
    },
  };
}

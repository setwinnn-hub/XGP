import type { Adapter } from '../../core/adapter.ts';
import type { HealthRegistry } from '../../core/health.ts';
import { errorMessage, type Logger } from '../../core/logger.ts';
import { ReconnectingSocket } from '../../core/reconnecting-socket.ts';
import { sleep } from '../../core/util.ts';
import type { TradeContext } from '../../trades/trade-sink.ts';
import type { ClassifiedTrade } from '../../trades/classify.ts';
import type { WalletRegistry } from '../../wallets/wallet-registry.ts';
import type { TrackedWallet } from '../../wallets/wallet-repo.ts';
import { classifySolanaTx, fetchParsedTransaction, fetchSignaturesSince, RpcRateLimitError, type ParsedSolanaTx } from './solana-trade.ts';

const SOURCE = 'solana:wallets';
const DECODER = 'solana-rpc';
/** Slots arrive every ~0.4s; 30s without one means the socket is dead. */
const STALE_AFTER_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const TX_ATTEMPTS = 8;
const CONCURRENCY = 2;
const MAX_QUEUE = 500;
const DROP_LOG_INTERVAL_MS = 60_000;

export interface SolanaWalletWatcherDeps {
  readonly wsUrl: string;
  readonly rpcUrl: string;
  readonly logger: Logger;
  readonly health: HealthRegistry;
  readonly registry: WalletRegistry;
  readonly sink: (trade: ClassifiedTrade, context: TradeContext) => Promise<void>;
  readonly fetchFn?: typeof fetch;
}

interface Job {
  readonly wallet: TrackedWallet;
  readonly signature: string;
  readonly detectedAt: number;
}

/**
 * Follows Solana wallets with logsSubscribe(mentions) on a WebSocket, then reads each
 * transaction and decodes BUY/SELL from balance changes (works for every DEX/aggregator).
 */
export function createSolanaWalletWatcher(deps: SolanaWalletWatcherDeps): Adapter {
  const logger = deps.logger.child({ source: SOURCE });
  let wallets: ReadonlyMap<string, TrackedWallet> = new Map();
  let nextId = 1;
  let pending = new Map<number, string>(); // request id -> wallet ('#slot' for heartbeat)
  let subs = new Map<number, string>(); // subscription id -> wallet
  let lastSignature = new Map<string, string>(); // wallet -> newest signature seen (backfill anchor)
  let lastResetAt = Date.now();
  let running = false;
  let watchdog: NodeJS.Timeout | null = null;
  const queue: Job[] = [];
  let workers = 0;
  let dropped = new Map<string, number>();
  let lastDropLogAt = 0;

  const request = (method: string, params: unknown[], tag: string): string => {
    const id = nextId++;
    pending = new Map(pending).set(id, tag);
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
  };
  const subscribeWallet = (address: string): string =>
    request('logsSubscribe', [{ mentions: [address] }, { commitment: 'confirmed' }], address);

  /** Retries every failure (not found yet, 429, 5xx, timeouts); null after TX_ATTEMPTS. */
  const fetchWithRetry = async (signature: string): Promise<ParsedSolanaTx | null> => {
    for (let attempt = 0; attempt < TX_ATTEMPTS; attempt += 1) {
      try {
        const tx = await fetchParsedTransaction(deps.rpcUrl, signature, deps.fetchFn);
        if (tx) return tx;
        await sleep(300 + attempt * 300);
      } catch (error: unknown) {
        const rateLimited = error instanceof RpcRateLimitError;
        if (!rateLimited) logger.debug('getTransaction failed, retrying', { signature, error: errorMessage(error) });
        await sleep((rateLimited ? 1_500 : 500) * (attempt + 1));
      }
    }
    return null;
  };

  /** After a reconnect, picks up transactions made while the socket was down. */
  const backfill = async (): Promise<void> => {
    for (const [address, until] of lastSignature) {
      const wallet = wallets.get(address);
      if (!wallet) continue;
      try {
        const missed = await fetchSignaturesSince(deps.rpcUrl, address, until, deps.fetchFn);
        if (missed.length > 0) logger.info('backfilling missed transactions', { wallet: address, count: missed.length });
        for (const signature of missed.reverse()) enqueue(wallet, signature);
      } catch (error: unknown) {
        logger.warn('backfill failed', { wallet: address, error: errorMessage(error) });
      }
    }
  };

  const processJob = async (job: Job): Promise<void> => {
    const tx = await fetchWithRetry(job.signature);
    if (!tx) return logger.warn('transaction not available', { signature: job.signature });
    const result = classifySolanaTx(tx, job.wallet.address);
    if (!result.ok) return logger.debug('not a swap', { signature: job.signature, reason: result.reason });
    await deps.sink(result.trade, {
      chain: 'solana', wallet: job.wallet, txHash: job.signature, detectedAt: job.detectedAt,
      decoder: DECODER, venue: null, chainTimeMs: tx.blockTime === null ? null : tx.blockTime * 1000,
    });
  };

  const pump = (): void => {
    while (workers < CONCURRENCY && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      workers += 1;
      processJob(job)
        .catch((error: unknown) => logger.error('wallet tx failed', { signature: job.signature, error: errorMessage(error) }))
        .finally(() => { workers -= 1; pump(); });
    }
  };

  const onMessage = (data: string): void => {
    const message = JSON.parse(data) as {
      id?: number; result?: unknown; error?: { message?: string };
      method?: string; params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown } } };
    };
    if (typeof message.id === 'number') {
      const id = message.id;
      const tag = pending.get(id);
      pending = new Map([...pending].filter(([key]) => key !== id));
      // A wallet removed before its subscribe answer arrived would leak; skip it.
      if (tag && typeof message.result === 'number' && (tag === '#slot' || wallets.has(tag))) {
        subs = new Map(subs).set(message.result, tag);
      }
      if (message.error) logger.warn('subscribe failed', { wallet: tag, error: message.error.message });
      return;
    }
    if (message.method === 'slotNotification') return void deps.health.beat(SOURCE);
    if (message.method !== 'logsNotification') return;
    const address = subs.get(message.params?.subscription ?? -1);
    const value = message.params?.result?.value;
    const wallet = address ? wallets.get(address) : undefined;
    if (!wallet || !value?.signature) return;
    lastSignature = new Map(lastSignature).set(wallet.address, value.signature);
    if (value.err === null) enqueue(wallet, value.signature);
  };

  function enqueue(wallet: TrackedWallet, signature: string): void {
    if (queue.length >= MAX_QUEUE) return noteDropped(wallet);
    queue.push({ wallet, signature, detectedAt: Date.now() });
    pump();
  }

  /**
   * The RPC cannot keep up (rate-limited endpoint and/or a very active wallet). Logs one
   * summary per minute instead of one line per dropped transaction.
   */
  function noteDropped(wallet: TrackedWallet): void {
    dropped = new Map(dropped).set(wallet.address, (dropped.get(wallet.address) ?? 0) + 1);
    if (Date.now() - lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
    lastDropLogAt = Date.now();
    logger.warn('Solana RPC cannot keep up; transactions dropped (use a Helius key or follow fewer very active wallets)', {
      droppedByWallet: Object.fromEntries(dropped),
    });
    dropped = new Map();
  }

  const socket = new ReconnectingSocket({
    url: deps.wsUrl,
    logger,
    onOpen: (send) => {
      pending = new Map();
      subs = new Map();
      lastResetAt = Date.now();
      send(request('slotSubscribe', [], '#slot'));
      for (const address of wallets.keys()) send(subscribeWallet(address));
      logger.info('subscribed', { wallets: wallets.size });
      void backfill();
    },
    onMessage,
    onReconnect: () => deps.health.countReconnect(SOURCE),
  });

  const applyWallets = (next: ReadonlyMap<string, TrackedWallet>): void => {
    const previous = wallets;
    wallets = next;
    if (!running && next.size > 0) return start();
    if (running && next.size === 0) return stop();
    for (const address of next.keys()) if (!previous.has(address)) socket.send(subscribeWallet(address));
    for (const [subId, address] of subs) {
      if (next.has(address) || address === '#slot') continue;
      socket.send(request('logsUnsubscribe', [subId], `-${address}`));
      subs = new Map([...subs].filter(([id]) => id !== subId));
    }
  };

  function start(): void {
    running = true;
    deps.health.register(SOURCE, STALE_AFTER_MS);
    socket.start();
    watchdog = setInterval(() => {
      const status = deps.health.snapshot().find((s) => s.name === SOURCE);
      const since = Math.max(status?.lastBeatAt ?? 0, lastResetAt);
      if (Date.now() - since <= STALE_AFTER_MS) return;
      lastResetAt = Date.now();
      socket.forceReconnect(`no slots for ${Math.round((Date.now() - since) / 1000)}s`);
    }, WATCHDOG_INTERVAL_MS);
  }

  function stop(): void {
    running = false;
    if (watchdog) clearInterval(watchdog);
    socket.stop();
    deps.health.unregister(SOURCE);
  }

  return {
    name: SOURCE,
    start() {
      deps.registry.onChange('solana', applyWallets);
    },
    stop,
  };
}

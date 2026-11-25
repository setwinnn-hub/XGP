import type { Adapter, AdapterDeps } from '../../core/adapter.ts';
import { errorMessage } from '../../core/logger.ts';
import { ReconnectingSocket } from '../../core/reconnecting-socket.ts';
import type { ClassifiedTrade } from '../../trades/classify.ts';
import type { TradeContext } from '../../trades/trade-sink.ts';
import type { WalletRegistry } from '../../wallets/wallet-registry.ts';
import type { TrackedWallet } from '../../wallets/wallet-repo.ts';
import { parsePumpPortalMessage, PUMPPORTAL_SOURCE, type PumpAccountTrade } from './pumpportal-parse.ts';

const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
/** Measured ~9 launches/minute (2026-11-25); 2 minutes of silence means the stream is dead. */
const STALE_AFTER_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const VENUES: Readonly<Record<string, string>> = { pump: 'Pump.fun', 'pump-amm': 'PumpSwap' };

export interface PumpPortalAdapterDeps extends AdapterDeps {
  readonly registry: WalletRegistry;
  readonly sink: (trade: ClassifiedTrade, context: TradeContext) => Promise<void>;
  /**
   * PumpPortal only serves subscribeAccountTrade to connections with a funded API key
   * (confirmed by its reply on 2026-11-25). Without one, wallet trades come from RPC only.
   */
  readonly apiKey: string | null;
}

/**
 * Pump.fun launches, migrations and followed-wallet trades from PumpPortal's free data
 * stream. PumpPortal allows one connection per client, so all subscriptions share it.
 * Wallet trades here are the fast path for Pump.fun/PumpSwap; the RPC watcher covers
 * every other DEX, and both produce the same key so a trade alerts once.
 */
export function createPumpPortalAdapter(deps: PumpPortalAdapterDeps): Adapter {
  const logger = deps.logger.child({ source: PUMPPORTAL_SOURCE });
  deps.health.register(PUMPPORTAL_SOURCE, STALE_AFTER_MS);
  let watchdog: NodeJS.Timeout | null = null;
  /** Start of the current silence window: last message, or last (re)start, whichever is later. */
  let lastResetAt = Date.now();
  let wallets: ReadonlyMap<string, TrackedWallet> = new Map();

  const handleTrade = (trade: PumpAccountTrade, receivedAt: number): void => {
    const wallet = wallets.get(trade.trader);
    // Zero-value "trades" are volume-bot dust, not real buys or sells.
    if (!wallet || trade.solAmount <= 0 || trade.tokenAmount <= 0) return;
    deps.sink(
      { side: trade.side, token: trade.mint, tokenAmount: trade.tokenAmount, quoteSymbol: 'SOL', quoteAmount: trade.solAmount, quoteIsStable: false },
      { chain: 'solana', wallet, txHash: trade.signature, detectedAt: receivedAt, decoder: PUMPPORTAL_SOURCE, venue: VENUES[trade.pool ?? ''] ?? trade.pool },
    ).catch((error: unknown) => logger.error('account trade failed', { signature: trade.signature, error: errorMessage(error) }));
  };

  const accountTrades = deps.apiKey !== null;
  const socket = new ReconnectingSocket({
    url: accountTrades ? `${PUMPPORTAL_URL}?api-key=${encodeURIComponent(deps.apiKey ?? '')}` : PUMPPORTAL_URL,
    logger,
    onOpen: (send) => {
      send(JSON.stringify({ method: 'subscribeNewToken' }));
      send(JSON.stringify({ method: 'subscribeMigration' }));
      if (accountTrades && wallets.size > 0) send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [...wallets.keys()] }));
    },
    onMessage: (data) => {
      const receivedAt = Date.now();
      deps.health.beat(PUMPPORTAL_SOURCE);
      const parsed = parsePumpPortalMessage(data, receivedAt);
      if (parsed.type === 'event') deps.ingest(PUMPPORTAL_SOURCE, parsed.event);
      else if (parsed.type === 'trade') handleTrade(parsed.trade, receivedAt);
      else if (parsed.type === 'control') logger.info('pumpportal', { message: parsed.message });
      else logger.debug('pumpportal message ignored', { reason: parsed.reason });
    },
    onReconnect: () => deps.health.countReconnect(PUMPPORTAL_SOURCE),
  });

  const applyWallets = (next: ReadonlyMap<string, TrackedWallet>): void => {
    const added = [...next.keys()].filter((address) => !wallets.has(address));
    const removed = [...wallets.keys()].filter((address) => !next.has(address));
    wallets = next;
    if (!accountTrades) return;
    // When the socket is closed, onOpen subscribes the full list on reconnect.
    if (added.length > 0) socket.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: added }));
    if (removed.length > 0) socket.send(JSON.stringify({ method: 'unsubscribeAccountTrade', keys: removed }));
  };

  return {
    name: PUMPPORTAL_SOURCE,
    start() {
      lastResetAt = Date.now();
      deps.registry.onChange('solana', applyWallets);
      socket.start();
      watchdog = setInterval(() => {
        const status = deps.health.snapshot().find((s) => s.name === PUMPPORTAL_SOURCE);
        const since = Math.max(status?.lastBeatAt ?? 0, lastResetAt);
        if (Date.now() - since <= STALE_AFTER_MS) return;
        lastResetAt = Date.now();
        socket.forceReconnect(`no data for ${Math.round((Date.now() - since) / 1000)}s`);
      }, WATCHDOG_INTERVAL_MS);
    },
    stop() {
      if (watchdog) clearInterval(watchdog);
      socket.stop();
    },
  };
}

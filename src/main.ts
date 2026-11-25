import type { Adapter, Ingest } from './core/adapter.ts';
import { createEventBus } from './core/bus.ts';
import { HealthRegistry, type HealthTransition } from './core/health.ts';
import { createIngest } from './core/ingest.ts';
import { createLogger, errorMessage, type Logger } from './core/logger.ts';
import { findEvmChain } from './chains/evm/chains.ts';
import { createEvmAdapter } from './chains/evm/evm-adapter.ts';
import { createEvmWalletScanner } from './chains/evm/wallet-scanner.ts';
import { createSolanaChainTimeResolver } from './chains/solana/chain-time.ts';
import { createPumpPortalAdapter } from './chains/solana/pumpportal-adapter.ts';
import { createSolanaWalletWatcher } from './chains/solana/wallet-watcher.ts';
import { loadConfig, wsUrlFor, type AppConfig } from './config.ts';
import { createPriceBook, type PriceBook } from './enrich/prices.ts';
import { createNameLookup } from './enrich/token-names.ts';
import { createNotifier, type Notifier } from './notify/notifier.ts';
import { decideAlert } from './notify/filters.ts';
import { AnalysisEngine, tokenToAnalyse } from './analysis/analysis-engine.ts';
import { createCoinGeckoTrendingAdapter } from './news/coingecko-trending.ts';
import { createNewsAdapter } from './news/news-adapter.ts';
import { openDatabase } from './storage/db.ts';
import { createEventRepository, type EventRepository } from './storage/event-repo.ts';
import { explorerUrls, toTradeEvent, type WalletTrade } from './trades/trade-event.ts';
import { createTradeSink } from './trades/trade-sink.ts';
import { WalletRegistry } from './wallets/wallet-registry.ts';
import { createWalletRepository } from './wallets/wallet-repo.ts';

const HEALTH_SWEEP_MS = 10_000;
const STATS_INTERVAL_MS = 60_000;
const WALLET_REFRESH_MS = 15_000;

function describeTransition(t: HealthTransition): string {
  const silent = t.silentForMs === null ? '' : ` (เงียบไป ${Math.round(t.silentForMs / 1000)} วินาที)`;
  if (t.to === 'down' && t.from === 'starting') return `แหล่งข้อมูล ${t.name} เชื่อมต่อไม่สำเร็จ ไม่มีข้อมูลเข้ามา${silent} — กำลังลองใหม่อัตโนมัติ`;
  if (t.to === 'down') return `แหล่งข้อมูล ${t.name} หยุดส่งข้อมูล${silent} — กำลังเชื่อมต่อใหม่อัตโนมัติ`;
  if (t.from === 'down') return `แหล่งข้อมูล ${t.name} กลับมาทำงานแล้ว${silent}`;
  return `แหล่งข้อมูล ${t.name} เชื่อมต่อสำเร็จ`;
}

/** Health source a trade counts toward, by the decoder that produced it. */
function tradeHealthName(trade: WalletTrade): string {
  if (trade.decoder === 'pumpportal') return 'pumpportal';
  return trade.chain === 'solana' ? 'solana:wallets' : `evm:${trade.chain}`;
}

interface Wiring {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly health: HealthRegistry;
  readonly repo: EventRepository;
  readonly ingest: Ingest;
  readonly registry: WalletRegistry;
  readonly prices: PriceBook;
}

function buildAdapters(w: Wiring): Adapter[] {
  const { config, logger, health, repo, ingest, registry } = w;
  const emit = (trade: WalletTrade, chainMs: number | null): void => {
    const event = toTradeEvent(trade, explorerUrls(trade.chain, findEvmChain(trade.chain)?.explorerTxUrl ?? null));
    if (ingest(tradeHealthName(trade), event) && chainMs !== null) repo.setChainTime(event.key, chainMs);
  };
  const sink = createTradeSink({ prices: w.prices, nameLookup: createNameLookup(repo, logger), emit });
  const onChainTime = (key: string, chainMs: number): void => repo.setChainTime(key, chainMs);
  const evm = config.evmChains.map((chain) => createEvmAdapter({
    logger, health, ingest, chain, wsUrl: wsUrlFor(chain), onChainTime,
    walletScanner: createEvmWalletScanner({ chain, logger, registry, sink }),
  }));
  const solanaWallets = config.solanaWalletTracking
    ? [createSolanaWalletWatcher({ wsUrl: config.solanaWsUrl, rpcUrl: config.solanaRpcUrl, logger, health, registry, sink })]
    : [];
  const news = config.news.enabled
    ? [
        createNewsAdapter({ logger, health, ingest, onPublished: onChainTime }),
        createCoinGeckoTrendingAdapter({ logger, health, ingest, minRank: config.news.trendingMinRank }),
      ]
    : [];
  return [
    createPumpPortalAdapter({ logger, health, ingest, registry, sink, apiKey: config.pumpPortalApiKey }),
    ...solanaWallets,
    ...evm,
    ...news,
  ];
}

function wireHealth(health: HealthRegistry, notifier: Notifier, logger: Logger): NodeJS.Timeout {
  health.onTransition((t) => {
    // A normal first connect is logged only; Discord hears about outages, dead starts and recoveries.
    if (t.from === 'starting' && t.to === 'up') return logger.info('source up', { source: t.name });
    void notifier.system(describeTransition(t), t.to === 'up');
  });
  return setInterval(() => health.sweep(), HEALTH_SWEEP_MS);
}

function logStats(health: HealthRegistry, registry: WalletRegistry, logger: Logger): void {
  const sources = health.snapshot().map((s) => ({
    source: s.name, state: s.state, events: s.events, reconnects: s.reconnects,
    lastBeatAgoSec: s.lastBeatAt ? Math.round((Date.now() - s.lastBeatAt) / 1000) : null,
  }));
  const wallets = Object.fromEntries((['solana', 'ethereum', 'base', 'bsc'] as const).map((c) => [c, registry.wallets(c).size]));
  logger.info('stats', { sources, wallets });
}

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logDir);
  const db = openDatabase(config.dbPath);
  const repo = createEventRepository(db);
  const health = new HealthRegistry();
  const bus = createEventBus(logger);
  const ingest = createIngest({ repo, bus, health, logger });
  const notifier = createNotifier({ config, repo, logger });
  const registry = new WalletRegistry(createWalletRepository(db), logger);
  const prices = createPriceBook(logger);

  const resolveSolanaTime = createSolanaChainTimeResolver({
    rpcUrl: config.solanaRpcUrl, logger, onResolved: (key, ms) => repo.setChainTime(key, ms),
  });
  bus.subscribe('notifier', (event) => notifier.handle(event));
  const analysis = config.analysis.enabled
    ? new AnalysisEngine({ config: config.analysis, repo, ingest, logger })
    : null;
  bus.subscribe('analysis', (event) => {
    const ref = analysis ? tokenToAnalyse(event, decideAlert(event, config).alert) : null;
    if (ref) analysis?.schedule(ref, event.kind === 'wallet_trade');
  });
  bus.subscribe('solana-chain-time', (event) => {
    if (event.chain !== 'solana' || event.source === 'solana-rpc') return;
    if (Math.random() < config.latencySampleRate) resolveSolanaTime(event.key, event.txHash);
  });

  prices.start();
  registry.start(WALLET_REFRESH_MS);
  analysis?.start();
  const adapters = buildAdapters({ config, logger, health, repo, ingest, registry, prices });
  const sweep = wireHealth(health, notifier, logger);
  const stats = setInterval(() => logStats(health, registry, logger), STATS_INTERVAL_MS);
  for (const adapter of adapters) adapter.start();

  logger.info('radar started', {
    sources: adapters.map((a) => a.name),
    dryRunCategories: notifier.dryRunCategories(),
    pumpfunNewTokenMode: config.pumpfun.newTokenMode,
  });
  void notifier.system(`เริ่มทำงาน: ${adapters.map((a) => a.name).join(', ')}`, true);

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    clearInterval(sweep);
    clearInterval(stats);
    registry.stop();
    prices.stop();
    analysis?.stop();
    for (const adapter of adapters) adapter.stop();
    // Give in-flight alerts a moment to record their delivery before the database closes.
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 1_500).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason: unknown) => logger.error('unhandled rejection', { error: errorMessage(reason) }));
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception, exiting for restart', { error: errorMessage(error), stack: error.stack });
    process.exit(1);
  });
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`startup failed: ${errorMessage(error)}\n`);
  process.exit(1);
}

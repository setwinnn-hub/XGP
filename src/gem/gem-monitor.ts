import { fetchMarkets, type MarketSnapshot } from '../analysis/market.ts';
import type { ChainId } from '../core/types.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import { detectAccumulation, type AccumulationReport, type AccumulationStatus } from './accumulation.ts';
import type { SignalEntry, SignalStore } from './signal-store.ts';
import { tokenCoverageSince } from './swap-collector.ts';
import type { SwapStore, WatchEntry } from './swap-store.ts';

const INTERVAL_MS = 60_000;
/** Enough history for the 60-minute window and the one before the 5-minute window. */
const LOOKBACK_MS = 75 * 60_000;
/** A verdict is stored when it changes, and at least this often while it stays the same. */
const RECORD_EVERY_MS = 15 * 60_000;
const NOTABLE: readonly AccumulationStatus[] = ['ACCUMULATING', 'PRE_PUMP', 'SUSPICIOUS'];

export interface GemMonitorDeps {
  readonly chains: readonly ChainId[];
  readonly swaps: SwapStore;
  readonly signals: SignalStore;
  /** Lower-cased followed-wallet addresses for a chain. */
  readonly smartWallets: (chain: ChainId) => ReadonlySet<string>;
  readonly logger: Logger;
  readonly fetchMarkets?: typeof fetchMarkets;
  readonly now?: () => number;
}

export interface GemMonitor {
  start(): void;
  stop(): void;
  /** One evaluation pass over every watched token (exposed for tests and scripts). */
  tick(): Promise<number>;
}

function metricsOf(report: AccumulationReport): Record<string, number | null> {
  return { ...report.metrics, clusters: report.clusters.length };
}

/** Evaluates accumulation / pre-pump for every watched token once a minute and keeps the history. */
export function createGemMonitor(deps: GemMonitorDeps): GemMonitor {
  const logger = deps.logger.child({ source: 'gem:monitor' });
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const markets = async (chain: ChainId, watches: readonly WatchEntry[]): Promise<ReadonlyMap<string, MarketSnapshot>> => {
    try {
      return await (deps.fetchMarkets ?? fetchMarkets)(chain, watches.map((w) => w.token));
    } catch (error: unknown) {
      // Without prices the detector still runs and says the price context is missing.
      logger.warn('market data unavailable for gem monitor', { chain, error: errorMessage(error) });
      return new Map();
    }
  };

  const evaluate = (chain: ChainId, watch: WatchEntry, market: MarketSnapshot | null, asOf: number, coverage: number): number => {
    const report = detectAccumulation({
      swaps: deps.swaps.swaps(chain, watch.token, asOf - LOOKBACK_MS),
      now: asOf, coverageSince: tokenCoverageSince(watch, coverage), smartWallets: deps.smartWallets(chain),
      price: market ? { changeM5Pct: market.priceChangePct.m5, changeH1Pct: market.priceChangePct.h1 } : null,
    });
    const last = deps.signals.latest(chain, watch.token);
    const changed = !last || last.status !== report.status || last.confidence !== report.confidence;
    if (!changed && asOf - last.at < RECORD_EVERY_MS) return 0;
    const entry: SignalEntry = { chain, token: watch.token, at: asOf, status: report.status, confidence: report.confidence, reasons: report.reasons, metrics: metricsOf(report) };
    deps.signals.record(entry);
    if (changed && NOTABLE.includes(report.status)) {
      logger.info('gem signal', { chain, token: watch.token, symbol: watch.symbol, status: report.status, confidence: report.confidence, reasons: report.reasons });
    }
    return 1;
  };

  const tick = async (): Promise<number> => {
    let recorded = 0;
    for (const chain of deps.chains) {
      const watches = deps.swaps.activeWatches(chain, now());
      const cursor = deps.swaps.cursor(chain);
      if (watches.length === 0 || !cursor) continue;
      const byToken = await markets(chain, watches);
      // Judge as of the collector's last scan, so a stalled collector never looks like "no buyers".
      const asOf = Math.min(now(), cursor.updatedAt);
      for (const watch of watches) {
        try {
          recorded += evaluate(chain, watch, byToken.get(watch.token.toLowerCase()) ?? null, asOf, cursor.coverageSince);
        } catch (error: unknown) {
          logger.warn('gem evaluation failed', { chain, token: watch.token, error: errorMessage(error) });
        }
      }
    }
    return recorded;
  };

  return {
    tick,
    start() {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        tick()
          .catch((error: unknown) => logger.warn('gem monitor pass failed', { error: errorMessage(error) }))
          .finally(() => { running = false; });
      }, INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

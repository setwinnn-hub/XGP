import type { MarketSnapshot } from '../analysis/market.ts';
import type { ChainId } from '../core/types.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import type { FxRate } from '../enrich/prices.ts';
import type { AccumulationReport } from './accumulation.ts';
import { scoreGem, type GemClass, type GemScore } from './gem-score.ts';
import type { LiquidityReport } from './liquidity.ts';
import { rangePosition, verifyMarketCap, type OnchainSupply } from './market-cap.ts';
import type { ScoreRecord, ScoreSnapshot, ScoreStore } from './score-store.ts';
import type { SecurityAssessment } from './security-engine.ts';
import type { GemSettings } from './settings.ts';
import type { WatchEntry } from './swap-store.ts';

/** Supply changes only by mint/burn; re-read every half hour. */
const SUPPLY_TTL_MS = 30 * 60_000;
const RECORD_EVERY_MS = 15 * 60_000;
const SCORE_CHANGE_RECORD = 5;
const PROMOTED: readonly GemClass[] = ['HIGH_POTENTIAL', 'EARLY_WATCH'];

export interface ScoreDeps {
  readonly store: ScoreStore;
  readonly settings: () => GemSettings;
  readonly fx: () => FxRate | null;
  readonly fetchSupply: (chain: ChainId, token: string) => Promise<OnchainSupply | null>;
  /** Followed wallets on a chain (0 = smart money cannot be judged there). */
  readonly trackedWallets: (chain: ChainId) => number;
  /** News mentions of a symbol in the last 24 h; null when the symbol cannot be matched safely. */
  readonly newsMentions: (symbol: string | null) => number | null;
  /** Called after every evaluation (recorded or not), e.g. for the watchlist and alerts. */
  readonly onScored?: (record: ScoreRecord) => void | Promise<void>;
  readonly now?: () => number;
}

export interface ScoreContext {
  readonly chain: ChainId;
  readonly watch: WatchEntry;
  readonly market: MarketSnapshot | null;
  readonly accumulation: AccumulationReport;
  readonly liquidity: LiquidityReport;
  readonly security: SecurityAssessment;
  readonly asOf: number;
  readonly allowSupplyFetch: boolean;
}

export interface ScoreEvaluator {
  evaluate(ctx: ScoreContext): Promise<{ gem: GemScore; supplyFetched: boolean; recorded: number }>;
}

function snapshotOf(ctx: ScoreContext, gem: GemScore, trackedWallets: number, thbPerUsd: number | null): ScoreSnapshot {
  const w5 = ctx.accumulation.windows.find((w) => w.minutes === 5);
  const w15 = ctx.accumulation.windows.find((w) => w.minutes === 15);
  const volume = ctx.market?.volumeUsd.m5 ?? null;
  const why = [...gem.categories].filter((c) => c.evidence && c.points > 0).sort((a, b) => b.points - a.points).slice(0, 4).map((c) => c.note);
  const risks = [
    ...ctx.security.reasons.filter((r) => !r.includes('ไม่ได้แปลว่าปลอดภัย')),
    ...ctx.liquidity.reasons.filter((r) => r.includes('เสียราคา') || r.includes('ลดลง') || r.includes('ฝั่งเงิน')),
  ].slice(0, 5);
  return {
    uniqueBuyers5m: w5?.complete ? ctx.accumulation.metrics.independentBuyers5m : null,
    uniqueBuyersGrowth5mPct: ctx.accumulation.metrics.acceleration === null ? null : (ctx.accumulation.metrics.acceleration - 1) * 100,
    buySellRatio15m: w15?.complete ? w15.buySellRatio : null,
    smartMoneyBuyers60m: ctx.accumulation.metrics.smartMoneyBuyers60m,
    trackedWallets,
    liquidityThb: ctx.liquidity.liquidityThb,
    exitLiquidityThb: ctx.liquidity.exitLiquidityThb,
    volume5mThb: volume !== null && thbPerUsd !== null ? volume * thbPerUsd : null,
    priceChangeH1Pct: ctx.market?.priceChangePct.h1 ?? null,
    liquidityFlags: ctx.liquidity.flags,
    whyDetected: why,
    mainRisks: risks,
    chartUrl: ctx.market?.pairUrl || null,
  };
}

export function createScoreEvaluator(deps: ScoreDeps, logger: Logger): ScoreEvaluator {
  const now = deps.now ?? Date.now;
  let supplies = new Map<string, { at: number; supply: OnchainSupply | null }>();

  const supplyFor = async (chain: ChainId, token: string, allowFetch: boolean): Promise<{ supply: OnchainSupply | null; fetched: boolean }> => {
    const key = `${chain}:${token.toLowerCase()}`;
    const cached = supplies.get(key);
    if (cached && now() - cached.at < SUPPLY_TTL_MS) return { supply: cached.supply, fetched: false };
    if (!allowFetch) return { supply: cached?.supply ?? null, fetched: false };
    try {
      const supply = await deps.fetchSupply(chain, token);
      supplies = new Map([...supplies].filter(([, v]) => now() - v.at < 4 * SUPPLY_TTL_MS)).set(key, { at: now(), supply });
      return { supply, fetched: true };
    } catch (error: unknown) {
      logger.debug('supply lookup failed', { chain, token, error: errorMessage(error) });
      return { supply: cached?.supply ?? null, fetched: true };
    }
  };

  return {
    async evaluate(ctx) {
      const settings = deps.settings();
      const { supply, fetched } = await supplyFor(ctx.chain, ctx.watch.token, ctx.allowSupplyFetch);
      const marketCap = ctx.market || supply ? verifyMarketCap(ctx.market, supply, deps.fx(), ctx.asOf) : null;
      const position = marketCap ? rangePosition(marketCap, settings.minMarketCapThb, settings.maxMarketCapThb) : 'UNKNOWN';
      const gem = scoreGem({
        accumulation: ctx.accumulation, liquidity: ctx.liquidity, security: ctx.security, marketCap, rangePosition: position,
        market: ctx.market, trackedWallets: deps.trackedWallets(ctx.chain), newsMentions24h: deps.newsMentions(ctx.watch.symbol),
        weights: settings.weights, thresholds: settings.thresholds,
      });
      const trackedWallets = deps.trackedWallets(ctx.chain);
      const record: ScoreRecord = {
        chain: ctx.chain, token: ctx.watch.token, symbol: ctx.watch.symbol, at: ctx.asOf, gem, marketCap, rangePosition: position,
        securityLevel: ctx.security.level, liquidity: ctx.liquidity.liquidity, activity: ctx.liquidity.activity, accumulation: ctx.accumulation.status,
        snapshot: snapshotOf(ctx, gem, trackedWallets, deps.fx()?.thbPerUsd ?? null),
      };
      if (deps.onScored) {
        try {
          await deps.onScored(record);
        } catch (error: unknown) {
          logger.warn('gem onScored hook failed', { token: ctx.watch.token, error: errorMessage(error) });
        }
      }
      const last = deps.store.latest(ctx.chain, ctx.watch.token);
      const changed = !last || last.gem.classification !== gem.classification;
      const due = !last || changed || Math.abs(last.gem.score - gem.score) >= SCORE_CHANGE_RECORD || ctx.asOf - last.at >= RECORD_EVERY_MS;
      if (!due) return { gem, supplyFetched: fetched, recorded: 0 };
      deps.store.record(record);
      if (changed && (PROMOTED.includes(gem.classification) || (last && PROMOTED.includes(last.gem.classification)))) {
        logger.info('gem classification', {
          chain: ctx.chain, token: ctx.watch.token, symbol: ctx.watch.symbol, from: last?.gem.classification ?? null,
          to: gem.classification, score: gem.score, confidence: gem.confidence, gate: gem.gateReasons,
        });
      }
      return { gem, supplyFetched: fetched, recorded: 1 };
    },
  };
}

import type { MarketSnapshot } from '../analysis/market.ts';
import type { ChainId } from '../core/types.ts';
import type { Logger } from '../core/logger.ts';
import type { AccumulationReport } from './accumulation.ts';
import { assessLiquidity, type LiquidityReport } from './liquidity.ts';
import type { PairRequest, PairReserves } from './pool-reserves.ts';
import type { QualityStore } from './quality-store.ts';
import type { SecurityCache } from './security-cache.ts';
import { assessSecurity, type SecurityAssessment } from './security-engine.ts';
import type { GemSettings } from './settings.ts';
import type { WatchEntry } from './swap-store.ts';

const HOUR = 60 * 60_000;
const LIQUIDITY_RECORD_MS = 10 * 60_000;
const LIQUIDITY_CHANGE_RECORD = 0.02;
const SECURITY_RECORD_MS = 30 * 60_000;

export interface QualityDeps {
  readonly store: QualityStore;
  readonly security: SecurityCache;
  readonly settings: () => GemSettings;
  readonly thbPerUsd: () => number | null;
  /** On-chain V2 reserves for a chain's pairs (absent = DexScreener values only). */
  readonly reserves?: (chain: ChainId, requests: readonly PairRequest[]) => Promise<ReadonlyMap<string, PairReserves>>;
}

export interface QualityContext {
  readonly chain: ChainId;
  readonly watch: WatchEntry;
  readonly market: MarketSnapshot | null;
  readonly reserves: PairReserves | null;
  readonly accumulation: AccumulationReport;
  readonly asOf: number;
  /** False once this pass has used its budget of security lookups. */
  readonly allowSecurityFetch: boolean;
}

export interface QualityResult {
  readonly liquidity: LiquidityReport;
  readonly security: SecurityAssessment;
  readonly securityFetched: boolean;
  readonly recorded: number;
}

function shouldRecordLiquidity(store: QualityStore, ctx: QualityContext, report: LiquidityReport): boolean {
  const last = store.latestLiquidity(ctx.chain, ctx.watch.token);
  if (!last) return true;
  if (ctx.asOf - last.at >= LIQUIDITY_RECORD_MS) return true;
  if (last.report.activity !== report.activity || last.report.liquidity !== report.liquidity) return true;
  const before = last.report.liquidityUsd;
  const now = report.liquidityUsd;
  return before !== null && now !== null && before > 0 && Math.abs(now - before) / before > LIQUIDITY_CHANGE_RECORD;
}

/** Liquidity + security for one watched token; stores what changed and logs what matters. */
export async function evaluateQuality(q: QualityDeps, ctx: QualityContext, logger: Logger): Promise<QualityResult> {
  const { chain, watch, market, accumulation, asOf } = ctx;
  const sources = await q.security.get(chain, watch.token, ctx.allowSecurityFetch);
  const w60 = accumulation.windows.find((w) => w.minutes === 60);
  const w15 = accumulation.windows.find((w) => w.minutes === 15);
  const liquidity = assessLiquidity({
    market, reserves: ctx.reserves, thbPerUsd: q.thbPerUsd(), settings: q.settings(), now: asOf,
    poolFee: sources.goplus?.extra?.poolFees[watch.pool.toLowerCase()] ?? null,
    history: q.store.liquidityHistory(chain, watch.token, asOf - HOUR),
    activity: {
      buys60m: w60?.complete ? w60.buys : null,
      uniqueBuyers60m: w60?.complete ? w60.uniqueBuyers : null,
      independentBuyers15m: w15?.complete ? accumulation.metrics.independentBuyers15m : null,
      buys15m: w15?.complete ? w15.buys : null,
      uniqueBuyers15m: w15?.complete ? w15.uniqueBuyers : null,
      dexTxnsH1: market ? market.txnsH1.buys + market.txnsH1.sells : null,
    },
  });
  const security = assessSecurity({ chain, poolKind: watch.poolKind, goplus: sources.goplus, honeypot: sources.honeypot, liquidityFlags: liquidity.flags });

  let recorded = 0;
  const lastLiquidity = q.store.latestLiquidity(chain, watch.token);
  if (shouldRecordLiquidity(q.store, ctx, liquidity)) {
    q.store.recordLiquidity(chain, watch.token, asOf, liquidity);
    recorded += 1;
  }
  if (liquidity.flags.includes('LIQUIDITY_DROP') && !lastLiquidity?.report.flags.includes('LIQUIDITY_DROP')) {
    logger.warn('gem liquidity drop', { chain, token: watch.token, symbol: watch.symbol, changePct: liquidity.changeFromPeak60mPct });
  }
  const lastSecurity = q.store.latestSecurity(chain, watch.token);
  if (!lastSecurity || lastSecurity.level !== security.level || sources.fetched || asOf - lastSecurity.at >= SECURITY_RECORD_MS) {
    q.store.recordSecurity(chain, watch.token, asOf, security);
    recorded += 1;
  }
  if (security.level === 'CRITICAL' && lastSecurity?.level !== 'CRITICAL') {
    logger.info('gem security critical', { chain, token: watch.token, symbol: watch.symbol, reasons: security.reasons });
  }
  return { liquidity, security, securityFetched: sources.fetched, recorded };
}

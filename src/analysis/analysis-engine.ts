import type { Ingest } from '../core/adapter.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import type { ChainId, RadarEvent } from '../core/types.ts';
import { sleep } from '../core/util.ts';
import type { EventRepository } from '../storage/event-repo.ts';
import { fetchMarket, type MarketSnapshot } from './market.ts';
import { scoreToken, type TokenScore } from './score.ts';
import { fetchSecurity, isVerified, type SecurityReport } from './security.ts';

const SOURCE = 'analysis';
const MAX_PENDING = 300;
const MIN_GAP_MS = 400;
const SECURITY_CACHE_MS = 5 * 60_000;
const RATE_LIMIT_PAUSE_MS = 60_000;
const SCHEDULED_TTL_MS = 6 * 60 * 60_000;
const NEWS_WINDOW_MS = 24 * 60 * 60_000;
/** Followed-wallet buys or this much raw attention make a risky token worth a warning. */
const RISK_ALERT_ATTENTION = 40;

export interface AnalysisConfig {
  /** Minutes after first sighting at which the token is analysed (e.g. [2, 15]). */
  readonly delaysMin: readonly number[];
  readonly minOpportunity: number;
}

export interface AnalysisDeps {
  readonly config: AnalysisConfig;
  readonly repo: EventRepository;
  readonly ingest: Ingest;
  readonly logger: Logger;
  readonly fetchMarket?: typeof fetchMarket;
  readonly fetchSecurity?: typeof fetchSecurity;
  readonly now?: () => number;
}

export interface TokenRef {
  readonly chain: ChainId;
  readonly token: string;
  readonly symbol: string | null;
  readonly name: string | null;
}

interface Job extends TokenRef {
  readonly stage: number;
  readonly runAt: number;
}

export interface AnalysisResult {
  readonly market: MarketSnapshot | null;
  readonly security: SecurityReport | null;
  readonly score: TokenScore;
  readonly smartBuyers: number;
}

/** EVM addresses are case-insensitive; Solana addresses are not. */
function tokenId(ref: TokenRef): string {
  return `${ref.chain}:${ref.chain === 'solana' ? ref.token : ref.token.toLowerCase()}`;
}

function analysisEvent(ref: TokenRef, result: AnalysisResult, key: string, alert: 'none' | 'opportunity' | 'risk', at: number): RadarEvent {
  const m = result.market;
  return {
    key,
    kind: 'analysis',
    chain: ref.chain,
    source: SOURCE,
    tokenAddress: ref.token,
    tokenName: ref.name,
    tokenSymbol: ref.symbol,
    txHash: m?.pairUrl ?? '',
    detectedAt: at,
    details: {
      alert,
      opportunity: result.score.opportunity,
      rawOpportunity: result.score.rawOpportunity,
      risk: result.score.risk,
      positives: JSON.stringify(result.score.positives),
      risks: JSON.stringify(result.score.risks),
      smartBuyers: result.smartBuyers,
      priceUsd: m?.priceUsd ?? null,
      liquidityUsd: m?.liquidityUsd ?? null,
      marketCapUsd: m?.marketCapUsd ?? null,
      volumeH1Usd: m?.volumeUsd.h1 ?? null,
      buysH1: m?.txnsH1.buys ?? null,
      sellsH1: m?.txnsH1.sells ?? null,
      changeH1Pct: m?.priceChangePct.h1 ?? null,
      dexId: m?.dexId ?? null,
      image: m?.imageUrl ?? null,
    },
    links: m?.pairUrl ? [{ label: 'DexScreener', url: m.pairUrl }] : [],
  };
}

/**
 * Analyses tokens a few minutes after they appear (and again later), scores opportunity
 * and risk, stores every result, and raises at most one HIGH_OPPORTUNITY and one HIGH_RISK
 * alert per token (enforced by the event key in the database).
 */
export class AnalysisEngine {
  private readonly deps: AnalysisDeps;
  private readonly logger: Logger;
  private queue: Job[] = [];
  private scheduled = new Map<string, number>();
  private securityCache = new Map<string, { at: number; report: SecurityReport | null }>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private securityPausedUntil = 0;

  constructor(deps: AnalysisDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ source: SOURCE });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Queues the analyses for a token once (later sightings of the same token are ignored).
   * Priority tokens (followed-wallet buys) are accepted even when the queue is full.
   */
  schedule(ref: TokenRef, priority = false): void {
    const id = tokenId(ref);
    const now = this.now();
    this.scheduled = new Map([...this.scheduled].filter(([, at]) => now - at < SCHEDULED_TTL_MS));
    if (this.scheduled.has(id) || ref.chain === 'offchain' || !ref.token) return;
    if (!priority && this.queue.length >= MAX_PENDING) return this.logger.warn('analysis queue full, skipping token', { token: ref.token });
    this.scheduled = new Map(this.scheduled).set(id, now);
    const jobs = this.deps.config.delaysMin.map((min, stage) => ({ ...ref, stage, runAt: now + min * 60_000 }));
    this.queue = [...this.queue, ...jobs].sort((a, b) => a.runAt - b.runAt);
  }

  start(): void {
    this.timer = setInterval(() => void this.drain(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue[0] && this.queue[0].runAt <= this.now()) {
        const [job, ...rest] = this.queue;
        this.queue = rest;
        if (!job) break;
        await this.run(job).catch((error: unknown) => this.logger.warn('analysis failed', { token: job.token, error: errorMessage(error) }));
        await sleep(MIN_GAP_MS);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * GoPlus report, cached briefly. Failures are never cached (the next stage retries) and a
   * rate-limit answer pauses all lookups for a minute.
   */
  private async security(ref: TokenRef): Promise<SecurityReport | null> {
    const id = tokenId(ref);
    const now = this.now();
    const cached = this.securityCache.get(id);
    if (cached && now - cached.at < SECURITY_CACHE_MS) return cached.report;
    if (now < this.securityPausedUntil) return null;
    try {
      const report = await (this.deps.fetchSecurity ?? fetchSecurity)(ref.chain, ref.token);
      if (report && isVerified(report)) {
        this.securityCache = new Map([...this.securityCache].filter(([, v]) => now - v.at < SECURITY_CACHE_MS)).set(id, { at: now, report });
      }
      return report;
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (/429|rate|limit/i.test(message)) {
        this.securityPausedUntil = now + RATE_LIMIT_PAUSE_MS;
        this.logger.warn('GoPlus rate limit; pausing security lookups', { pauseSec: RATE_LIMIT_PAUSE_MS / 1000 });
      } else {
        this.logger.debug('security lookup failed', { token: ref.token, error: message });
      }
      return null;
    }
  }

  /** One analysis: fetch, score, store, and alert when thresholds are met. */
  async analyse(ref: TokenRef): Promise<AnalysisResult> {
    const market = await (this.deps.fetchMarket ?? fetchMarket)(ref.chain, ref.token).catch((error: unknown) => {
      this.logger.debug('market lookup failed', { token: ref.token, error: errorMessage(error) });
      return null;
    });
    const security = await this.security(ref);
    const smartBuyers = this.deps.repo.countSmartBuyers(ref.chain, ref.token);
    const newsMentions = ref.symbol ? this.deps.repo.countNewsMentions(ref.symbol, this.now() - NEWS_WINDOW_MS) : 0;
    const score = scoreToken(market, security, { smartMoneyBuyers: smartBuyers, newsMentions, now: this.now() });
    return { market, security, score, smartBuyers };
  }

  private async run(job: Job): Promise<void> {
    const result = await this.analyse(job);
    const at = this.now();
    const id = tokenId(job);
    this.deps.ingest(SOURCE, analysisEvent(job, result, `analysis:${id}:${job.stage}`, 'none', at));
    const { score } = result;
    const lowRisk = score.risk === 'LOW' || score.risk === 'MEDIUM';
    // An opportunity alert is permanent per token: never spend it before the contract was checked.
    if (lowRisk && isVerified(result.security) && score.opportunity >= this.deps.config.minOpportunity) {
      this.deps.ingest(SOURCE, analysisEvent(job, result, `alert:opportunity:${id}`, 'opportunity', at));
    }
    const attention = result.smartBuyers > 0 || score.rawOpportunity >= RISK_ALERT_ATTENTION;
    if (!lowRisk && attention) this.deps.ingest(SOURCE, analysisEvent(job, result, `alert:risk:${id}`, 'risk', at));
  }
}

/** Which events start a token analysis: tokens we alerted on or that followed wallets bought. */
export function tokenToAnalyse(event: RadarEvent, alerted: boolean): TokenRef | null {
  const ref = { chain: event.chain, token: event.tokenAddress, symbol: event.tokenSymbol, name: event.tokenName };
  if (event.kind === 'wallet_trade') return event.details.side === 'BUY' ? ref : null;
  if (event.kind === 'token_migrated' || event.kind === 'token_launched' || event.kind === 'pair_created') return alerted ? ref : null;
  return null;
}

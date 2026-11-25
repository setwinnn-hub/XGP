export interface Mention {
  readonly symbol: string;
  readonly source: string;
  readonly title: string;
  readonly link: string;
  readonly at: number;
}

export interface TrendSignal {
  readonly symbol: string;
  readonly mentions: number;
  readonly sources: readonly string[];
  readonly examples: readonly Mention[];
  readonly windowMs: number;
  readonly cooldownMs: number;
}

export interface TrendTrackerOptions {
  readonly windowMs: number;
  readonly minMentions: number;
  readonly minSources: number;
  readonly cooldownMs: number;
}

export const DEFAULT_TREND_OPTIONS: TrendTrackerOptions = {
  windowMs: 60 * 60_000,
  minMentions: 3,
  minSources: 2,
  cooldownMs: 6 * 60 * 60_000,
};

/** Upper bound on remembered mentions; a flood of headlines cannot grow memory or CPU without limit. */
const MAX_MENTIONS = 5_000;

/**
 * Counts how often each coin is mentioned across news sources in a sliding window and
 * reports a coin once when it is suddenly talked about in several places.
 */
export class TrendTracker {
  private bySymbol = new Map<string, readonly Mention[]>();
  private total = 0;
  private lastAlert = new Map<string, number>();
  private readonly options: TrendTrackerOptions;

  constructor(options: TrendTrackerOptions = DEFAULT_TREND_OPTIONS) {
    this.options = options;
  }

  /** Records a mention and returns a signal if the coin just crossed the trend threshold. */
  record(mention: Mention): TrendSignal | null {
    this.prune(mention.at);
    if (this.total >= MAX_MENTIONS) return null;
    const recent = [...(this.bySymbol.get(mention.symbol) ?? []), mention];
    this.bySymbol = new Map(this.bySymbol).set(mention.symbol, recent);
    this.total += 1;

    const sources = [...new Set(recent.map((m) => m.source))];
    if (recent.length < this.options.minMentions || sources.length < this.options.minSources) return null;
    const last = this.lastAlert.get(mention.symbol);
    if (last !== undefined && mention.at - last < this.options.cooldownMs) return null;
    this.lastAlert = new Map(this.lastAlert).set(mention.symbol, mention.at);
    return {
      symbol: mention.symbol, mentions: recent.length, sources, examples: recent.slice(-3),
      windowMs: this.options.windowMs, cooldownMs: this.options.cooldownMs,
    };
  }

  /** Drops mentions outside the window and cooldowns that have expired. */
  private prune(now: number): void {
    const since = now - this.options.windowMs;
    const kept = [...this.bySymbol].flatMap(([symbol, list]) => {
      const fresh = list.filter((m) => m.at >= since);
      return fresh.length > 0 ? [[symbol, fresh] as const] : [];
    });
    this.bySymbol = new Map(kept);
    this.total = kept.reduce((sum, [, list]) => sum + list.length, 0);
    this.lastAlert = new Map([...this.lastAlert].filter(([, at]) => now - at < this.options.cooldownMs));
  }
}

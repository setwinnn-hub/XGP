import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, SCORE_CATEGORIES, type ScoreThresholds, type ScoreWeights } from './gem-score.ts';

/** User-adjustable Early Gem settings (edited from the Dashboard; stored in the DB). */
export interface GemSettings {
  readonly minMarketCapThb: number;
  readonly maxMarketCapThb: number;
  /** Pool liquidity below this is INSUFFICIENT_LIQUIDITY. */
  readonly minLiquidityThb: number;
  /** Trade size used to estimate buy and sell slippage. */
  readonly testTradeThb: number;
  /** Estimated slippage (either side) above this is INSUFFICIENT_LIQUIDITY. */
  readonly maxSlippagePct: number;
  /** Below these over 60 minutes = LOW_ACTIVITY (real trading, not enough data yet). */
  readonly minBuyTransactions: number;
  readonly minUniqueBuyers: number;
  readonly minIndependentWallets: number;
  /** Early Gem Score category weights (any non-negative numbers; the score is scaled to 100). */
  readonly weights: ScoreWeights;
  readonly thresholds: ScoreThresholds;
  /** Discord EARLY GEM / GEM RISK alerts on or off. */
  readonly gemAlertsEnabled: boolean;
  /** Minimum time between two new EARLY GEM messages for the same token. */
  readonly alertCooldownMin: number;
  /** Minimum time between edits of a token's existing message. */
  readonly editIntervalMin: number;
  /** Consecutive one-minute passes a new class must hold before the watchlist moves a token up or down. */
  readonly confirmPasses: number;
}

/** Market cap defaults confirmed by the user on 2026-11-25 (Pump.fun's floor is ~66,000 THB). */
export const DEFAULT_GEM_SETTINGS: GemSettings = {
  minMarketCapThb: 66_000,
  maxMarketCapThb: 500_000,
  minLiquidityThb: 100_000,
  testTradeThb: 5_000,
  maxSlippagePct: 10,
  minBuyTransactions: 10,
  minUniqueBuyers: 8,
  minIndependentWallets: 6,
  weights: DEFAULT_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  gemAlertsEnabled: true,
  alertCooldownMin: 60,
  editIntervalMin: 5,
  confirmPasses: 2,
};

const KEY = 'gem';

function validNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function normalizeWeights(raw: unknown): ScoreWeights {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const weights = Object.fromEntries(SCORE_CATEGORIES.map((c) => [c, validNumber(r[c], DEFAULT_WEIGHTS[c], 0, 1000)])) as Record<string, number>;
  // All-zero weights would make every score 0/0.
  return SCORE_CATEGORIES.some((c) => (weights[c] ?? 0) > 0) ? (weights as ScoreWeights) : DEFAULT_WEIGHTS;
}

function normalizeThresholds(raw: unknown): ScoreThresholds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_THRESHOLDS;
  const high = validNumber(r.highPotentialScore, d.highPotentialScore, 0, 100);
  const watch = validNumber(r.earlyWatchScore, d.earlyWatchScore, 0, 100);
  return {
    highPotentialScore: Math.max(high, watch),
    earlyWatchScore: Math.min(high, watch),
    highPotentialMinConfidence: validNumber(r.highPotentialMinConfidence, d.highPotentialMinConfidence, 0, 100),
  };
}

/** Merges stored values over the defaults; invalid stored values fall back to defaults. */
export function normalizeSettings(raw: unknown): GemSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GEM_SETTINGS;
  const min = validNumber(r.minMarketCapThb, d.minMarketCapThb, 0, 1e13);
  const max = validNumber(r.maxMarketCapThb, d.maxMarketCapThb, 0, 1e13);
  const range = min <= max ? { minMarketCapThb: min, maxMarketCapThb: max } : { minMarketCapThb: d.minMarketCapThb, maxMarketCapThb: d.maxMarketCapThb };
  return {
    ...range,
    minLiquidityThb: validNumber(r.minLiquidityThb, d.minLiquidityThb, 0, 1e13),
    testTradeThb: validNumber(r.testTradeThb, d.testTradeThb, 1, 1e9),
    maxSlippagePct: validNumber(r.maxSlippagePct, d.maxSlippagePct, 0.1, 100),
    minBuyTransactions: validNumber(r.minBuyTransactions, d.minBuyTransactions, 0, 1e6),
    minUniqueBuyers: validNumber(r.minUniqueBuyers, d.minUniqueBuyers, 0, 1e6),
    minIndependentWallets: validNumber(r.minIndependentWallets, d.minIndependentWallets, 0, 1e6),
    weights: normalizeWeights(r.weights),
    thresholds: normalizeThresholds(r.thresholds),
    gemAlertsEnabled: typeof r.gemAlertsEnabled === 'boolean' ? r.gemAlertsEnabled : d.gemAlertsEnabled,
    alertCooldownMin: validNumber(r.alertCooldownMin, d.alertCooldownMin, 0, 7 * 24 * 60),
    editIntervalMin: validNumber(r.editIntervalMin, d.editIntervalMin, 1, 24 * 60),
    confirmPasses: Math.round(validNumber(r.confirmPasses, d.confirmPasses, 1, 10)),
  };
}

export interface SettingsRepository {
  get(): GemSettings;
  save(settings: GemSettings): GemSettings;
}

export function createSettingsRepository(db: DatabaseSync, now: () => number = Date.now): SettingsRepository {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const read = db.prepare('SELECT value_json FROM settings WHERE key = ?');
  const write = db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
  return {
    get() {
      const row = read.get(KEY);
      if (!row) return DEFAULT_GEM_SETTINGS;
      try {
        return normalizeSettings(JSON.parse(String(row.value_json)));
      } catch {
        return DEFAULT_GEM_SETTINGS;
      }
    },
    save(settings) {
      const clean = normalizeSettings(settings);
      write.run(KEY, JSON.stringify(clean), now());
      return clean;
    },
  };
}

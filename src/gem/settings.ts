import type { DatabaseSync } from 'node:sqlite';

/** User-adjustable Early Gem settings (edited from the Dashboard; stored in the DB). */
export interface GemSettings {
  readonly minMarketCapThb: number;
  readonly maxMarketCapThb: number;
}

/** Defaults confirmed by the user on 2026-11-25 (Pump.fun's floor is ~66,000 THB). */
export const DEFAULT_GEM_SETTINGS: GemSettings = {
  minMarketCapThb: 66_000,
  maxMarketCapThb: 500_000,
};

const KEY = 'gem';

function validNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Merges stored values over the defaults; invalid stored values fall back to defaults. */
export function normalizeSettings(raw: unknown): GemSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const min = validNumber(r.minMarketCapThb, DEFAULT_GEM_SETTINGS.minMarketCapThb, 0, 1e13);
  const max = validNumber(r.maxMarketCapThb, DEFAULT_GEM_SETTINGS.maxMarketCapThb, 0, 1e13);
  return min <= max ? { minMarketCapThb: min, maxMarketCapThb: max } : DEFAULT_GEM_SETTINGS;
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

import type { DatabaseSync } from 'node:sqlite';
import type { AccumulationStatus, Confidence } from './accumulation.ts';

/** One accumulation verdict for a token, kept as history for the watchlist and backtests. */
export interface SignalEntry {
  readonly chain: string;
  readonly token: string;
  readonly at: number;
  readonly status: AccumulationStatus;
  readonly confidence: Confidence;
  readonly reasons: readonly string[];
  readonly metrics: Readonly<Record<string, number | null>>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gem_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL,
  status TEXT NOT NULL, confidence TEXT NOT NULL, reasons_json TEXT NOT NULL, metrics_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gem_signals_token ON gem_signals (chain, token, at);
CREATE INDEX IF NOT EXISTS idx_gem_signals_at ON gem_signals (at);
`;

export interface SignalStore {
  record(entry: SignalEntry): void;
  latest(chain: string, token: string): SignalEntry | null;
  /** Newest first. */
  history(chain: string, token: string, limit: number): readonly SignalEntry[];
}

function parseJson<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

export function createSignalStore(db: DatabaseSync): SignalStore {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO gem_signals (chain, token, at, status, confidence, reasons_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT * FROM gem_signals WHERE chain = ? AND token = ? ORDER BY at DESC LIMIT ?');
  const toEntry = (r: Record<string, unknown>): SignalEntry => ({
    chain: String(r.chain), token: String(r.token), at: Number(r.at),
    status: String(r.status) as AccumulationStatus, confidence: String(r.confidence) as Confidence,
    reasons: parseJson<string[]>(r.reasons_json, []), metrics: parseJson<Record<string, number | null>>(r.metrics_json, {}),
  });
  return {
    record(e) {
      insert.run(e.chain, e.token, e.at, e.status, e.confidence, JSON.stringify(e.reasons), JSON.stringify(e.metrics));
    },
    latest(chain, token) {
      const row = select.get(chain, token, 1);
      return row ? toEntry(row) : null;
    },
    history(chain, token, limit) {
      return select.all(chain, token, limit).map(toEntry);
    },
  };
}

import type { DatabaseSync } from 'node:sqlite';
import type { GemClass, GemScore } from './gem-score.ts';
import type { MarketCapReport, RangePosition } from './market-cap.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gem_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL, token TEXT NOT NULL, symbol TEXT, at INTEGER NOT NULL,
  classification TEXT NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL,
  report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gem_scores_token ON gem_scores (chain, token, at);
CREATE INDEX IF NOT EXISTS idx_gem_scores_at ON gem_scores (at);
`;

/** Numbers shown in the Discord alert, captured at scoring time. */
export interface ScoreSnapshot {
  readonly uniqueBuyers5m: number | null;
  readonly uniqueBuyersGrowth5mPct: number | null;
  readonly buySellRatio15m: number | null;
  readonly smartMoneyBuyers60m: number;
  readonly trackedWallets: number;
  readonly liquidityThb: number | null;
  readonly exitLiquidityThb: number | null;
  readonly volume5mThb: number | null;
  readonly priceChangeH1Pct: number | null;
  readonly liquidityFlags: readonly string[];
  readonly whyDetected: readonly string[];
  readonly mainRisks: readonly string[];
  readonly chartUrl: string | null;
}

/** Everything a reader needs to see why a token got its class (kept as history, never overwritten). */
export interface ScoreRecord {
  readonly chain: string;
  readonly token: string;
  readonly symbol: string | null;
  readonly at: number;
  readonly gem: GemScore;
  readonly marketCap: MarketCapReport | null;
  readonly rangePosition: RangePosition;
  readonly securityLevel: string;
  readonly liquidity: string;
  readonly activity: string;
  readonly accumulation: string;
  readonly snapshot?: ScoreSnapshot;
}

export interface ScoreStore {
  record(r: ScoreRecord): void;
  latest(chain: string, token: string): ScoreRecord | null;
  /** Latest record per token updated since `sinceMs`, best score first. */
  current(sinceMs: number): readonly ScoreRecord[];
  history(chain: string, token: string, limit: number): readonly { at: number; classification: GemClass; score: number; confidence: number }[];
}

function parse(text: unknown): ScoreRecord | null {
  try {
    return JSON.parse(String(text)) as ScoreRecord;
  } catch {
    return null;
  }
}

export function createScoreStore(db: DatabaseSync): ScoreStore {
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT INTO gem_scores (chain, token, symbol, at, classification, score, confidence, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const last = db.prepare('SELECT report_json FROM gem_scores WHERE chain = ? AND token = ? ORDER BY at DESC, id DESC LIMIT 1');
  const current = db.prepare(`SELECT s.report_json FROM gem_scores s
    JOIN (SELECT chain, token, max(id) AS id FROM gem_scores WHERE at >= ? GROUP BY chain, token) m ON m.id = s.id
    ORDER BY s.score DESC`);
  const hist = db.prepare('SELECT at, classification, score, confidence FROM gem_scores WHERE chain = ? AND token = ? ORDER BY at DESC, id DESC LIMIT ?');
  return {
    record(r) {
      ins.run(r.chain, r.token, r.symbol, r.at, r.gem.classification, r.gem.score, r.gem.confidence, JSON.stringify(r));
    },
    latest(chain, token) {
      const row = last.get(chain, token);
      return row ? parse(row.report_json) : null;
    },
    current(sinceMs) {
      return current.all(sinceMs).flatMap((row) => parse(row.report_json) ?? []);
    },
    history(chain, token, limit) {
      return hist.all(chain, token, limit).map((row) => ({
        at: Number(row.at), classification: String(row.classification) as GemClass, score: Number(row.score), confidence: Number(row.confidence),
      }));
    },
  };
}

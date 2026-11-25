import type { DatabaseSync } from 'node:sqlite';
import type { LiquidityReport, LiquiditySnapshot } from './liquidity.ts';
import type { SecurityAssessment, SecurityLevel } from './security-engine.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gem_liquidity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL,
  liquidity_usd REAL, activity TEXT NOT NULL, status TEXT NOT NULL, report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gem_liquidity_token ON gem_liquidity (chain, token, at);
CREATE TABLE IF NOT EXISTS gem_security (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL,
  level TEXT NOT NULL, report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gem_security_token ON gem_security (chain, token, at);
`;

export interface StoredLiquidity {
  readonly at: number;
  readonly report: LiquidityReport;
}

export interface StoredSecurity {
  readonly at: number;
  readonly level: SecurityLevel;
  readonly assessment: SecurityAssessment;
}

/** History of liquidity and security verdicts per watched token (inputs for scoring and backtests). */
export interface QualityStore {
  recordLiquidity(chain: string, token: string, at: number, report: LiquidityReport): void;
  /** Liquidity values recorded since `sinceMs` (oldest first), for change detection. */
  liquidityHistory(chain: string, token: string, sinceMs: number): readonly LiquiditySnapshot[];
  latestLiquidity(chain: string, token: string): StoredLiquidity | null;
  recordSecurity(chain: string, token: string, at: number, assessment: SecurityAssessment): void;
  latestSecurity(chain: string, token: string): StoredSecurity | null;
}

function parse<T>(text: unknown): T | null {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return null;
  }
}

export function createQualityStore(db: DatabaseSync): QualityStore {
  db.exec(SCHEMA);
  const insLiq = db.prepare('INSERT INTO gem_liquidity (chain, token, at, liquidity_usd, activity, status, report_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const histLiq = db.prepare('SELECT at, liquidity_usd FROM gem_liquidity WHERE chain = ? AND token = ? AND at >= ? AND liquidity_usd IS NOT NULL ORDER BY at');
  const lastLiq = db.prepare('SELECT at, report_json FROM gem_liquidity WHERE chain = ? AND token = ? ORDER BY at DESC LIMIT 1');
  const insSec = db.prepare('INSERT INTO gem_security (chain, token, at, level, report_json) VALUES (?, ?, ?, ?, ?)');
  const lastSec = db.prepare('SELECT at, level, report_json FROM gem_security WHERE chain = ? AND token = ? ORDER BY at DESC LIMIT 1');
  return {
    recordLiquidity(chain, token, at, r) {
      insLiq.run(chain, token, at, r.liquidityUsd, r.activity, r.liquidity, JSON.stringify(r));
    },
    liquidityHistory(chain, token, sinceMs) {
      return histLiq.all(chain, token, sinceMs).map((row) => ({ at: Number(row.at), liquidityUsd: Number(row.liquidity_usd) }));
    },
    latestLiquidity(chain, token) {
      const row = lastLiq.get(chain, token);
      const report = row ? parse<LiquidityReport>(row.report_json) : null;
      return row && report ? { at: Number(row.at), report } : null;
    },
    recordSecurity(chain, token, at, a) {
      insSec.run(chain, token, at, a.level, JSON.stringify(a));
    },
    latestSecurity(chain, token) {
      const row = lastSec.get(chain, token);
      const assessment = row ? parse<SecurityAssessment>(row.report_json) : null;
      return row && assessment ? { at: Number(row.at), level: String(row.level) as SecurityLevel, assessment } : null;
    },
  };
}

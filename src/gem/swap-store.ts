import type { DatabaseSync } from 'node:sqlite';

export type PoolKind = 'pair' | 'v4';

/** A token whose swaps are being collected (survives restarts). */
export interface WatchEntry {
  readonly chain: string;
  readonly token: string;
  /** Pair/pool contract (V2/V3) or V4 pool id (bytes32). */
  readonly pool: string;
  readonly poolKind: PoolKind;
  readonly symbol: string | null;
  readonly reason: string;
  readonly addedAt: number;
  readonly expiresAt: number;
}

/** One buy or sell, netted per transaction, by the wallet that signed it. */
export interface SwapRow {
  readonly chain: string;
  readonly token: string;
  readonly txHash: string;
  readonly side: 'BUY' | 'SELL';
  readonly wallet: string;
  readonly tokenAmount: number;
  readonly block: number;
  readonly blockTime: number;
  /** Signer's nonce for this tx (0–1 = brand-new wallet); null when unknown. */
  readonly nonce?: number | null;
  /** Priority fee (EIP-1559) or gas price, in gwei; a wallet-software fingerprint for clustering. */
  readonly feeGwei?: number | null;
}

/** Columns added after the first release of gem_swaps (Stage 7). */
const SWAP_COLUMNS_V2 = [['nonce', 'INTEGER'], ['fee_gwei', 'REAL']] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gem_watch (
  chain TEXT NOT NULL, token TEXT NOT NULL, pool TEXT NOT NULL, pool_kind TEXT NOT NULL,
  symbol TEXT, reason TEXT NOT NULL, added_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (chain, token)
);
CREATE TABLE IF NOT EXISTS gem_swaps (
  chain TEXT NOT NULL, token TEXT NOT NULL, tx_hash TEXT NOT NULL, side TEXT NOT NULL, wallet TEXT NOT NULL,
  token_amount REAL NOT NULL, block INTEGER NOT NULL, block_time INTEGER NOT NULL,
  PRIMARY KEY (chain, token, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_gem_swaps_time ON gem_swaps (chain, token, block_time);
CREATE TABLE IF NOT EXISTS gem_cursor (
  chain TEXT PRIMARY KEY, block INTEGER NOT NULL, coverage_since INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

/**
 * Why a token is watched, highest priority first: the collector reads only the first 40
 * watches per chain, so tokens already on the Early Gem watchlist never lose their slot
 * to a flood of brand-new pairs.
 */
export const WATCH_REASON_PRIORITY: Readonly<Record<string, number>> = { watchlist: 3, analysed: 2, 'new-pair': 1 };
const PRIORITY_SQL = (col: string): string =>
  `CASE ${col} ${Object.entries(WATCH_REASON_PRIORITY).map(([r, p]) => `WHEN '${r}' THEN ${p}`).join(' ')} ELSE 0 END`;

export interface ScanCursor {
  readonly block: number;
  /** Swaps are complete from this time on (reset when blocks had to be skipped). */
  readonly coverageSince: number;
}

export interface StoredCursor extends ScanCursor {
  /** When the collector last finished a scan: recorded swaps are current up to about here. */
  readonly updatedAt: number;
}

export interface SwapStore {
  /** Adds a token to the watchlist or extends its expiry; returns true when it was new. */
  watch(entry: WatchEntry): boolean;
  activeWatches(chain: string, now: number): readonly WatchEntry[];
  findWatch(chain: string, token: string): WatchEntry | null;
  insertSwaps(rows: readonly SwapRow[]): number;
  /** All recorded swaps of a token since `sinceMs`, oldest first. */
  swaps(chain: string, token: string, sinceMs: number): readonly SwapRow[];
  cursor(chain: string): StoredCursor | null;
  saveCursor(chain: string, cursor: ScanCursor, now: number): void;
}

function migrate(db: DatabaseSync): void {
  const existing = new Set(db.prepare('PRAGMA table_info(gem_swaps)').all().map((c) => String(c.name)));
  for (const [name, type] of SWAP_COLUMNS_V2) {
    if (!existing.has(name)) db.exec(`ALTER TABLE gem_swaps ADD COLUMN ${name} ${type}`);
  }
}

export function createSwapStore(db: DatabaseSync): SwapStore {
  db.exec(SCHEMA);
  migrate(db);
  const upsertWatch = db.prepare(`
    INSERT INTO gem_watch (chain, token, pool, pool_kind, symbol, reason, added_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain, token) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at),
      reason = CASE WHEN ${PRIORITY_SQL('excluded.reason')} > ${PRIORITY_SQL('reason')} THEN excluded.reason ELSE reason END,
      symbol = COALESCE(symbol, excluded.symbol)`);
  const getWatch = db.prepare('SELECT * FROM gem_watch WHERE chain = ? AND token = ?');
  const active = db.prepare(`SELECT * FROM gem_watch WHERE chain = ? AND expires_at > ? ORDER BY ${PRIORITY_SQL('reason')} DESC, added_at DESC`);
  const insertSwap = db.prepare(`INSERT OR IGNORE INTO gem_swaps (chain, token, tx_hash, side, wallet, token_amount, block, block_time, nonce, fee_gwei)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectSwaps = db.prepare('SELECT * FROM gem_swaps WHERE chain = ? AND token = ? AND block_time >= ? ORDER BY block_time, tx_hash');
  const getCursor = db.prepare('SELECT block, coverage_since, updated_at FROM gem_cursor WHERE chain = ?');
  const putCursor = db.prepare(`INSERT INTO gem_cursor (chain, block, coverage_since, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (chain) DO UPDATE SET block = excluded.block, coverage_since = excluded.coverage_since, updated_at = excluded.updated_at`);

  const toWatch = (r: Record<string, unknown>): WatchEntry => ({
    chain: String(r.chain), token: String(r.token), pool: String(r.pool), poolKind: r.pool_kind === 'v4' ? 'v4' : 'pair',
    symbol: typeof r.symbol === 'string' ? r.symbol : null, reason: String(r.reason),
    addedAt: Number(r.added_at), expiresAt: Number(r.expires_at),
  });

  return {
    watch(entry) {
      const existed = getWatch.get(entry.chain, entry.token) !== undefined;
      upsertWatch.run(entry.chain, entry.token, entry.pool, entry.poolKind, entry.symbol, entry.reason, entry.addedAt, entry.expiresAt);
      return !existed;
    },
    activeWatches(chain, now) {
      return active.all(chain, now).map(toWatch);
    },
    findWatch(chain, token) {
      const row = getWatch.get(chain, token);
      return row ? toWatch(row) : null;
    },
    insertSwaps(rows) {
      let added = 0;
      for (const r of rows) {
        added += Number(insertSwap.run(r.chain, r.token, r.txHash, r.side, r.wallet, r.tokenAmount, r.block, r.blockTime, r.nonce ?? null, r.feeGwei ?? null).changes);
      }
      return added;
    },
    swaps(chain, token, sinceMs) {
      return selectSwaps.all(chain, token, sinceMs).map((r) => ({
        chain: String(r.chain), token: String(r.token), txHash: String(r.tx_hash), side: r.side === 'SELL' ? 'SELL' : 'BUY',
        wallet: String(r.wallet), tokenAmount: Number(r.token_amount), block: Number(r.block), blockTime: Number(r.block_time),
        nonce: r.nonce === null || r.nonce === undefined ? null : Number(r.nonce),
        feeGwei: r.fee_gwei === null || r.fee_gwei === undefined ? null : Number(r.fee_gwei),
      }));
    },
    cursor(chain) {
      const row = getCursor.get(chain);
      return row ? { block: Number(row.block), coverageSince: Number(row.coverage_since), updatedAt: Number(row.updated_at) } : null;
    },
    saveCursor(chain, cursor, now) {
      putCursor.run(chain, cursor.block, cursor.coverageSince, now);
    },
  };
}

import type { DatabaseSync } from 'node:sqlite';
import type { GemClass } from './gem-score.ts';

/**
 * Early Gem watchlist: tokens that reached EARLY_WATCH or HIGH_POTENTIAL at least once, with
 * their current class, Discord message and every class change kept forever (spec Phase 9).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gem_watchlist (
  chain TEXT NOT NULL, token TEXT NOT NULL, symbol TEXT,
  status TEXT NOT NULL, since INTEGER NOT NULL, added_at INTEGER NOT NULL,
  pending_status TEXT, pending_count INTEGER NOT NULL DEFAULT 0,
  best_score REAL NOT NULL DEFAULT 0,
  message_id TEXT, last_alert_at INTEGER, last_edit_at INTEGER, last_alert_score REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain, token)
);
CREATE TABLE IF NOT EXISTS gem_watchlist_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL, token TEXT NOT NULL, at INTEGER NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL, score REAL NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gem_watchlist_events ON gem_watchlist_events (chain, token, at);
`;

/** Classes that put a token on the watchlist. */
export const LISTED: readonly GemClass[] = ['EARLY_WATCH', 'HIGH_POTENTIAL'];
/** Risk moves apply at once; everything else must hold for `confirmPasses` passes. */
const IMMEDIATE: readonly GemClass[] = ['REJECTED', 'HIGH_RISK'];

export interface WatchlistEntry {
  readonly chain: string;
  readonly token: string;
  readonly symbol: string | null;
  readonly status: GemClass;
  readonly since: number;
  readonly addedAt: number;
  readonly pendingStatus: GemClass | null;
  readonly pendingCount: number;
  readonly bestScore: number;
  readonly messageId: string | null;
  readonly lastAlertAt: number | null;
  readonly lastEditAt: number | null;
  readonly lastAlertScore: number | null;
}

export interface Observation {
  readonly chain: string;
  readonly token: string;
  readonly symbol: string | null;
  readonly classification: GemClass;
  readonly score: number;
  readonly confidence: number;
  readonly reason: string;
  readonly at: number;
}

export type Transition =
  | { readonly kind: 'not-listed' }
  | { readonly kind: 'unchanged'; readonly entry: WatchlistEntry }
  | { readonly kind: 'pending'; readonly entry: WatchlistEntry }
  | { readonly kind: 'moved'; readonly from: GemClass | null; readonly to: GemClass; readonly entry: WatchlistEntry };

export interface Watchlist {
  /** Feeds one scoring result; returns what happened to the token on the list. */
  observe(o: Observation, confirmPasses: number): Transition;
  get(chain: string, token: string): WatchlistEntry | null;
  all(): readonly WatchlistEntry[];
  recordAlert(chain: string, token: string, messageId: string | null, at: number, score: number, kind: 'new' | 'edit'): void;
  events(chain: string, token: string): readonly { at: number; from: string | null; to: string; score: number; reason: string }[];
}

export function createWatchlist(db: DatabaseSync): Watchlist {
  db.exec(SCHEMA);
  const getRow = db.prepare('SELECT * FROM gem_watchlist WHERE chain = ? AND token = ?');
  const allRows = db.prepare('SELECT * FROM gem_watchlist ORDER BY updated_at DESC');
  const insert = db.prepare(`INSERT INTO gem_watchlist (chain, token, symbol, status, since, added_at, best_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const move = db.prepare(`UPDATE gem_watchlist SET status = ?, since = ?, pending_status = NULL, pending_count = 0,
    best_score = MAX(best_score, ?), updated_at = ? WHERE chain = ? AND token = ?`);
  const setPending = db.prepare(`UPDATE gem_watchlist SET pending_status = ?, pending_count = ?, best_score = MAX(best_score, ?), updated_at = ?
    WHERE chain = ? AND token = ?`);
  const alertNew = db.prepare('UPDATE gem_watchlist SET message_id = ?, last_alert_at = ?, last_edit_at = ?, last_alert_score = ? WHERE chain = ? AND token = ?');
  const alertEdit = db.prepare('UPDATE gem_watchlist SET last_edit_at = ?, last_alert_score = ? WHERE chain = ? AND token = ?');
  const insertEvent = db.prepare(`INSERT INTO gem_watchlist_events (chain, token, at, from_status, to_status, score, confidence, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const listEvents = db.prepare('SELECT at, from_status, to_status, score, reason FROM gem_watchlist_events WHERE chain = ? AND token = ? ORDER BY at, id');

  const toEntry = (r: Record<string, unknown>): WatchlistEntry => ({
    chain: String(r.chain), token: String(r.token), symbol: r.symbol === null ? null : String(r.symbol),
    status: String(r.status) as GemClass, since: Number(r.since), addedAt: Number(r.added_at),
    pendingStatus: r.pending_status === null ? null : (String(r.pending_status) as GemClass), pendingCount: Number(r.pending_count),
    bestScore: Number(r.best_score), messageId: r.message_id === null ? null : String(r.message_id),
    lastAlertAt: r.last_alert_at === null ? null : Number(r.last_alert_at), lastEditAt: r.last_edit_at === null ? null : Number(r.last_edit_at),
    lastAlertScore: r.last_alert_score === null ? null : Number(r.last_alert_score),
  });
  const get = (chain: string, token: string): WatchlistEntry | null => {
    const row = getRow.get(chain, token);
    return row ? toEntry(row) : null;
  };
  /** Streaks of tokens not listed yet (in memory: a restart only delays a join by one pass). */
  const joinStreaks = new Map<string, { cls: GemClass; count: number }>();
  const event = (o: Observation, from: GemClass | null): void => {
    insertEvent.run(o.chain, o.token, o.at, from, o.classification, o.score, o.confidence, o.reason);
  };

  return {
    observe(o, confirmPasses) {
      const current = get(o.chain, o.token);
      if (!current) {
        // Joins only by reaching a listed class, confirmed like any other upward move.
        if (!LISTED.includes(o.classification)) return { kind: 'not-listed' };
        if (confirmPasses > 1) return pendingJoin(o, confirmPasses);
        insert.run(o.chain, o.token, o.symbol, o.classification, o.at, o.at, o.score, o.at);
        event(o, null);
        return { kind: 'moved', from: null, to: o.classification, entry: get(o.chain, o.token)! };
      }
      if (current.status === o.classification) {
        if (current.pendingStatus !== null) setPending.run(null, 0, o.score, o.at, o.chain, o.token);
        return { kind: 'unchanged', entry: get(o.chain, o.token)! };
      }
      const count = current.pendingStatus === o.classification ? current.pendingCount + 1 : 1;
      if (IMMEDIATE.includes(o.classification) || count >= confirmPasses) {
        move.run(o.classification, o.at, o.score, o.at, o.chain, o.token);
        event(o, current.status);
        return { kind: 'moved', from: current.status, to: o.classification, entry: get(o.chain, o.token)! };
      }
      setPending.run(o.classification, count, o.score, o.at, o.chain, o.token);
      return { kind: 'pending', entry: get(o.chain, o.token)! };
    },
    get,
    all: () => allRows.all().map(toEntry),
    recordAlert(chain, token, messageId, at, score, kind) {
      if (kind === 'new') alertNew.run(messageId, at, at, score, chain, token);
      else alertEdit.run(at, score, chain, token);
    },
    events: (chain, token) => listEvents.all(chain, token).map((r) => ({
      at: Number(r.at), from: r.from_status === null ? null : String(r.from_status), to: String(r.to_status), score: Number(r.score), reason: String(r.reason),
    })),
  };

  /** A token joins only after holding a listed class for `confirmPasses` passes. */
  function pendingJoin(o: Observation, confirmPasses: number): Transition {
    const key = `${o.chain}:${o.token}`;
    const streak = joinStreaks.get(key);
    const count = streak && streak.cls === o.classification ? streak.count + 1 : 1;
    if (count < confirmPasses) {
      joinStreaks.set(key, { cls: o.classification, count });
      return { kind: 'not-listed' };
    }
    joinStreaks.delete(key);
    insert.run(o.chain, o.token, o.symbol, o.classification, o.at, o.at, o.score, o.at);
    event(o, null);
    return { kind: 'moved', from: null, to: o.classification, entry: get(o.chain, o.token)! };
  }
}

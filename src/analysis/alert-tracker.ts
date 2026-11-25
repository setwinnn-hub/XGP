import type { DatabaseSync } from 'node:sqlite';
import { errorMessage, type Logger } from '../core/logger.ts';
import type { ChainId } from '../core/types.ts';
import type { DiscordPayload } from '../notify/discord-client.ts';
import { buildDailySummary, buildFollowUps, type FollowUp, type SummaryRow } from '../notify/format-followup.ts';
import type { MarketSnapshot } from './market.ts';

const HOUR = 3_600_000;
/** Hours after an alert at which its price is checked and reported. */
export const CHECKPOINTS_H = [1, 6, 24] as const;
/** A checkpoint missed by more than this (bot was off) is skipped, not posted late. */
const GRACE_MS = 2 * HOUR;
const TICK_MS = 5 * 60_000;
const SUMMARY_HOUR_LOCAL = 9;

export interface AlertTrackerDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
  readonly fetchMarket: (chain: ChainId, token: string) => Promise<MarketSnapshot | null>;
  /** Posts to the room where opportunity alerts go. */
  readonly send: (payload: DiscordPayload) => Promise<unknown>;
  readonly now?: () => number;
  /** IANA zone for the 09:00 summary; default is this machine's time zone. */
  readonly timeZone?: string;
}

export interface AlertTracker {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

interface AlertRow {
  readonly key: string;
  readonly chain: ChainId;
  readonly token: string;
  readonly symbol: string | null;
  readonly at: number;
  readonly priceUsd: number | null;
  readonly score: number | null;
}

/** Calendar day ("2026-11-26") and hour in the given time zone (default: this machine's). */
function localParts(ms: number, timeZone?: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}),
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * Follows every opportunity alert: price change after 1, 6 and 24 hours (one grouped message
 * per check), and a 09:00 daily summary of the last 24 hours. Results are stored, so the
 * threshold can later be tuned on evidence instead of guesses.
 */
export function createAlertTracker(deps: AlertTrackerDeps): AlertTracker {
  const { db } = deps;
  const logger = deps.logger.child({ source: 'alert-tracker' });
  const now = deps.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_followups (
      alert_key TEXT NOT NULL, hours INTEGER NOT NULL, price_usd REAL, change_pct REAL, at INTEGER NOT NULL,
      PRIMARY KEY (alert_key, hours));
    CREATE TABLE IF NOT EXISTS daily_reports (day TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  const alertsStmt = db.prepare(`
    SELECT event_key, chain, token_address, token_symbol, t_detected,
      json_extract(details_json, '$.priceUsd') AS price_usd, json_extract(details_json, '$.opportunity') AS score
    FROM events WHERE kind = 'analysis' AND event_key LIKE 'alert:opportunity:%' AND t_detected >= ? ORDER BY t_detected`);
  const doneStmt = db.prepare('SELECT 1 FROM alert_followups WHERE alert_key = ? AND hours = ?');
  const saveStmt = db.prepare('INSERT OR IGNORE INTO alert_followups (alert_key, hours, price_usd, change_pct, at) VALUES (?, ?, ?, ?, ?)');
  const reportedStmt = db.prepare('SELECT 1 FROM daily_reports WHERE day = ?');
  const saveReportStmt = db.prepare('INSERT OR IGNORE INTO daily_reports (day, at) VALUES (?, ?)');
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const alertsSince = (since: number): AlertRow[] => alertsStmt.all(since).map((r) => ({
    key: String(r.event_key), chain: String(r.chain) as ChainId, token: String(r.token_address),
    symbol: typeof r.token_symbol === 'string' ? r.token_symbol : null, at: Number(r.t_detected),
    priceUsd: typeof r.price_usd === 'number' && r.price_usd > 0 ? r.price_usd : null,
    score: typeof r.score === 'number' ? r.score : null,
  }));

  const priceNow = async (a: AlertRow): Promise<number | null> => {
    const m = await deps.fetchMarket(a.chain, a.token).catch((error: unknown) => {
      logger.debug('follow-up price failed', { token: a.token, error: errorMessage(error) });
      return null;
    });
    return m?.priceUsd ?? null;
  };

  const change = (from: number, to: number): number => ((to - from) / from) * 100;

  const followUps = async (t: number): Promise<void> => {
    const due: FollowUp[] = [];
    for (const a of alertsSince(t - (Math.max(...CHECKPOINTS_H) * HOUR + GRACE_MS))) {
      if (a.priceUsd === null) continue;
      for (const h of CHECKPOINTS_H) {
        const dueAt = a.at + h * HOUR;
        if (t < dueAt || t - dueAt > GRACE_MS || doneStmt.get(a.key, h)) continue;
        const price = await priceNow(a);
        if (price === null) continue;
        const pct = change(a.priceUsd, price);
        saveStmt.run(a.key, h, price, pct, t);
        due.push({ chain: a.chain, token: a.token, symbol: a.symbol, hours: h, fromUsd: a.priceUsd, toUsd: price, changePct: pct });
      }
    }
    if (due.length > 0) await deps.send(buildFollowUps(due, t));
  };

  const dailySummary = async (t: number): Promise<void> => {
    const { day, hour } = localParts(t, deps.timeZone);
    if (hour < SUMMARY_HOUR_LOCAL || reportedStmt.get(day)) return;
    const rows: SummaryRow[] = [];
    for (const a of alertsSince(t - 24 * HOUR)) {
      const price = a.priceUsd === null ? null : await priceNow(a);
      rows.push({ chain: a.chain, token: a.token, symbol: a.symbol, score: a.score, changePct: a.priceUsd !== null && price !== null ? change(a.priceUsd, price) : null });
    }
    // Saved first: a failed post is not retried all morning (it is logged instead).
    saveReportStmt.run(day, t);
    await deps.send(buildDailySummary(rows, day, t));
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const t = now();
      await followUps(t).catch((error: unknown) => logger.warn('follow-ups failed', { error: errorMessage(error) }));
      await dailySummary(t).catch((error: unknown) => logger.warn('daily summary failed', { error: errorMessage(error) }));
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      timer = setInterval(() => void tick(), TICK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

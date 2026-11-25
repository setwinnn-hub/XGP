import type { DatabaseSync } from 'node:sqlite';
import type { DeliveryStatus, RadarEvent } from '../core/types.ts';
import { getAddress } from 'viem';

/** As given, lower-case and checksummed: EVM events store either form depending on the source. */
function addressForms(address: string): [string, string, string] {
  let checksummed = address;
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    try { checksummed = getAddress(address.toLowerCase()); } catch { /* not an EVM address */ }
  }
  return [address, address.toLowerCase(), checksummed];
}

export interface LatencyRow {
  readonly source: string;
  readonly kind: string;
  readonly chain: string;
  readonly tChain: number | null;
  readonly tDetected: number;
  readonly tProcessed: number | null;
  readonly tDiscord: number | null;
  readonly delivery: string | null;
}

export interface DeliveryUpdate {
  readonly status: DeliveryStatus;
  readonly processedAt: number;
  readonly discordAt: number | null;
  readonly note: string | null;
}

/** Storage boundary for events. A Postgres implementation can replace this without touching callers. */
export interface EventRepository {
  /** Stores the event; returns false when an event with the same key already exists. */
  insert(event: RadarEvent): boolean;
  recordDelivery(key: string, update: DeliveryUpdate): void;
  setChainTime(key: string, chainMs: number): void;
  /** True when an event with this key was stored. */
  hasEvent(key: string): boolean;
  /** When the radar first saw this token launch or get a pool (ms), or null if it never did. */
  tokenCreatedAt(chain: string, tokenAddress: string): number | null;
  findTokenName(chain: string, tokenAddress: string): { name: string | null; symbol: string | null } | null;
  latencyRows(sinceMs: number): readonly LatencyRow[];
  /** How many earlier trades of this side the wallet made in this token (for "bought again" badges). */
  countPriorTrades(chain: string, wallet: string, token: string, side: string, beforeMs: number): number;
  /** All recorded followed-wallet trades since `sinceMs`, oldest first. */
  walletTrades(sinceMs: number): ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Distinct followed wallets that bought this token. */
  countSmartBuyers(chain: string, token: string): number;
  /** Stored news items since `sinceMs` naming this symbol as a $ticker or known meme name. */
  countNewsMentions(symbol: string, sinceMs: number): number;
  /** Keys and block numbers of stored EVM pair events for one chain, for completeness checks. */
  pairEventBlocks(chain: string, sinceMs: number): ReadonlyArray<{ readonly key: string; readonly blockNumber: number | null }>;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createEventRepository(db: DatabaseSync): EventRepository {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (event_key, kind, chain, source, token_address, token_name, token_symbol, tx_hash, details_json, t_detected)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deliveryStmt = db.prepare(
    'UPDATE events SET delivery = ?, t_processed = ?, t_discord = ?, delivery_note = ? WHERE event_key = ?',
  );
  const hasEventStmt = db.prepare('SELECT 1 FROM events WHERE event_key = ?');
  // Chain time when known, else detection time; uses the (kind, chain, token_address) index.
  const createdAtStmt = db.prepare(`
    SELECT MIN(COALESCE(t_chain, t_detected)) AS at FROM events
    WHERE kind IN ('token_launched', 'pair_created') AND chain = ? AND token_address IN (?, ?, ?)`);
  const chainTimeStmt = db.prepare('UPDATE events SET t_chain = ? WHERE event_key = ?');
  const nameStmt = db.prepare(`
    SELECT token_name, token_symbol FROM events
    WHERE chain = ? AND token_address = ? AND token_name IS NOT NULL
    ORDER BY t_detected ASC LIMIT 1`);
  const latencyStmt = db.prepare(`
    SELECT source, kind, chain, t_chain, t_detected, t_processed, t_discord, delivery
    FROM events WHERE t_detected >= ? ORDER BY t_detected ASC`);
  const priorTradesStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE kind = 'wallet_trade' AND chain = ? AND token_address = ? AND t_detected < ?
      AND json_extract(details_json, '$.wallet') = ? AND json_extract(details_json, '$.side') = ?`);
  const walletTradesStmt = db.prepare(`
    SELECT chain, token_address, token_symbol, t_detected, details_json FROM events
    WHERE kind = 'wallet_trade' AND t_detected >= ? ORDER BY t_detected`);
  const smartBuyersStmt = db.prepare(`
    SELECT COUNT(DISTINCT json_extract(details_json, '$.wallet')) AS n FROM events
    WHERE kind = 'wallet_trade' AND chain = ? AND token_address IN (?, ?) AND json_extract(details_json, '$.side') = 'BUY'`);
  const newsMentionsStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE kind = 'news' AND t_detected >= ?
      AND (',' || json_extract(details_json, '$.tickers') || ',' LIKE ? OR ',' || json_extract(details_json, '$.memeNames') || ',' LIKE ?)`);
  const pairBlocksStmt = db.prepare(`
    SELECT event_key, json_extract(details_json, '$.blockNumber') AS block_number
    FROM events WHERE kind = 'pair_created' AND chain = ? AND t_detected >= ?`);

  return {
    insert(event) {
      const result = insertStmt.run(
        event.key, event.kind, event.chain, event.source, event.tokenAddress,
        event.tokenName, event.tokenSymbol, event.txHash, JSON.stringify(event.details), event.detectedAt,
      );
      return Number(result.changes) > 0;
    },
    recordDelivery(key, update) {
      deliveryStmt.run(update.status, update.processedAt, update.discordAt, update.note, key);
    },
    setChainTime(key, chainMs) {
      chainTimeStmt.run(chainMs, key);
    },
    tokenCreatedAt(chain, tokenAddress) {
      return asNumberOrNull(createdAtStmt.get(chain, ...addressForms(tokenAddress))?.at);
    },
    hasEvent(key) {
      return hasEventStmt.get(key) !== undefined;
    },
    findTokenName(chain, tokenAddress) {
      const row = nameStmt.get(chain, tokenAddress);
      if (!row) return null;
      return { name: asStringOrNull(row.token_name), symbol: asStringOrNull(row.token_symbol) };
    },
    latencyRows(sinceMs) {
      return latencyStmt.all(sinceMs).map((row) => ({
        source: String(row.source),
        kind: String(row.kind),
        chain: String(row.chain),
        tChain: asNumberOrNull(row.t_chain),
        tDetected: asNumberOrNull(row.t_detected) ?? 0,
        tProcessed: asNumberOrNull(row.t_processed),
        tDiscord: asNumberOrNull(row.t_discord),
        delivery: asStringOrNull(row.delivery),
      }));
    },
    countPriorTrades(chain, wallet, token, side, beforeMs) {
      return Number(priorTradesStmt.get(chain, token, beforeMs, wallet, side)?.n ?? 0);
    },
    walletTrades(sinceMs) {
      return walletTradesStmt.all(sinceMs);
    },
    countSmartBuyers(chain, token) {
      // Uses the (kind, chain, token_address) index; EVM trades store lower-case, pairs checksummed.
      return Number(smartBuyersStmt.get(chain, token, token.toLowerCase())?.n ?? 0);
    },
    countNewsMentions(symbol, sinceMs) {
      const clean = symbol.toUpperCase();
      // Very short or unusual symbols are copied by scam tokens and would match unrelated news.
      if (!/^[A-Z0-9]{3,12}$/.test(clean)) return 0;
      const pattern = `%,${clean},%`;
      return Number(newsMentionsStmt.get(sinceMs, pattern, pattern)?.n ?? 0);
    },
    pairEventBlocks(chain, sinceMs) {
      return pairBlocksStmt.all(chain, sinceMs).map((row) => ({
        key: String(row.event_key),
        blockNumber: asNumberOrNull(row.block_number),
      }));
    },
  };
}

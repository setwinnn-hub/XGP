import { errorMessage, type Logger } from '../core/logger.ts';
import type { DiscordPayload, SendOutcome } from '../notify/discord-client.ts';
import { buildEarlyGemAlert, buildGemRiskAlert, type GemLinks } from '../notify/format-gem.ts';
import type { ScoreRecord } from './score-store.ts';
import type { GemSettings } from './settings.ts';
import { LISTED, type Watchlist } from './watchlist.ts';

/** Edits only when the score moved at least this much since the message was last written. */
const EDIT_MIN_SCORE_CHANGE = 3;

export interface GemAlertDeps {
  readonly watchlist: Watchlist;
  readonly settings: () => GemSettings;
  readonly send: (category: 'EARLY_GEM' | 'GEM_RISK', payload: DiscordPayload, editMessageId: string | null) => Promise<SendOutcome | null>;
  readonly links: (chain: string, token: string) => GemLinks;
  /** A token joined or moved up on the watchlist (e.g. keep collecting its swaps for a day). */
  readonly onListed?: (record: ScoreRecord) => void;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** Key data a qualified alert may not go out without (spec: no qualified alert on incomplete data). */
export function missingForAlert(r: ScoreRecord): string[] {
  const missing: string[] = [];
  if (r.marketCap?.status !== 'VERIFIED') missing.push('market cap ไม่ VERIFIED');
  if (!r.marketCap?.fx) missing.push('ไม่มีอัตรา THB/USD');
  if (r.securityLevel === 'UNKNOWN' || r.securityLevel === 'CRITICAL') missing.push(`security ${r.securityLevel}`);
  if (r.liquidity !== 'OK') missing.push(`liquidity ${r.liquidity}`);
  if (!r.snapshot) missing.push('ไม่มีข้อมูลสรุป');
  return missing;
}

const isDanger = (r: ScoreRecord): boolean => r.securityLevel === 'CRITICAL' || (r.snapshot?.liquidityFlags ?? []).includes('LIQUIDITY_DROP');

/**
 * Turns scoring results into watchlist moves and Discord messages: one EARLY GEM message per
 * qualification (edited in place afterwards, new message only after the cooldown), and a
 * separate GEM RISK message when a listed token turns dangerous.
 */
export function createGemAlerts(deps: GemAlertDeps): { onScored(record: ScoreRecord): Promise<void> } {
  const logger = deps.logger.child({ source: 'gem:alerts' });
  const now = deps.now ?? Date.now;

  const deliver = async (r: ScoreRecord, category: 'EARLY_GEM' | 'GEM_RISK', payload: DiscordPayload, editId: string | null): Promise<string | null> => {
    const outcome = await deps.send(category, payload, editId).catch((error: unknown) => {
      logger.warn('gem alert failed', { token: r.token, error: errorMessage(error) });
      return null;
    });
    return outcome?.status === 'sent' ? (outcome.messageId ?? editId) : null;
  };

  return {
    async onScored(r) {
      const s = deps.settings();
      const t = deps.watchlist.observe({
        chain: r.chain, token: r.token, symbol: r.symbol, classification: r.gem.classification, score: r.gem.score,
        confidence: r.gem.confidence, reason: r.gem.gateReasons[0] ?? `คะแนน ${r.gem.score}`, at: r.at,
      }, s.confirmPasses);
      if (t.kind === 'not-listed' || t.kind === 'pending') return;
      const entry = t.entry;
      if (t.kind === 'moved') {
        logger.info('watchlist move', { chain: r.chain, token: r.token, symbol: r.symbol, from: t.from, to: t.to, score: r.gem.score });
        if (LISTED.includes(t.to)) deps.onListed?.(r);
      }
      if (!s.gemAlertsEnabled) return;
      const links = deps.links(r.chain, r.token);

      if (t.kind === 'moved' && t.to === 'HIGH_POTENTIAL') {
        const missing = missingForAlert(r);
        if (missing.length > 0) return logger.warn('qualified gem not alerted: key data missing', { token: r.token, missing });
        const coolingDown = entry.lastAlertAt !== null && now() - entry.lastAlertAt < s.alertCooldownMin * 60_000;
        const editId = coolingDown ? entry.messageId : null;
        const id = await deliver(r, 'EARLY_GEM', buildEarlyGemAlert(r, links, entry.lastAlertAt ?? r.at), editId);
        if (id) deps.watchlist.recordAlert(r.chain, r.token, id, now(), r.gem.score, editId ? 'edit' : 'new');
        return;
      }
      if (t.kind === 'moved') {
        // A qualified message stays truthful: edit it to show the downgrade and why.
        if (t.from === 'HIGH_POTENTIAL' && entry.messageId) {
          const id = await deliver(r, 'EARLY_GEM', buildEarlyGemAlert(r, links, entry.lastAlertAt ?? r.at), entry.messageId);
          if (id) deps.watchlist.recordAlert(r.chain, r.token, id, now(), r.gem.score, 'edit');
        }
        if (isDanger(r) && t.from !== null && LISTED.includes(t.from)) await deliver(r, 'GEM_RISK', buildGemRiskAlert(r, links, t.from), null);
        return;
      }
      // Unchanged and still qualified: refresh the numbers now and then.
      const due = entry.lastEditAt === null || now() - entry.lastEditAt >= s.editIntervalMin * 60_000;
      const moved = Math.abs(r.gem.score - (entry.lastAlertScore ?? r.gem.score)) >= EDIT_MIN_SCORE_CHANGE;
      if (entry.status === 'HIGH_POTENTIAL' && entry.messageId && due && moved) {
        const id = await deliver(r, 'EARLY_GEM', buildEarlyGemAlert(r, links, entry.lastAlertAt ?? r.at), entry.messageId);
        if (id) deps.watchlist.recordAlert(r.chain, r.token, id, now(), r.gem.score, 'edit');
      }
    },
  };
}

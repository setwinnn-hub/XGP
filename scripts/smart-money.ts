/**
 * Ranks followed wallets by their real recorded trades (FIFO realized P/L, win rate,
 * holding time). Usage: npm run smartmoney [days=30] [--post]
 *   --post  also sends the ranking to Discord (SMART_MONEY_BUY channel, or DEFAULT).
 */
import { MIN_CLOSED_FOR_RANK, MIN_STAKE_FOR_RANK_USD, rankWallets, type TradeRecord, type WalletStats } from '../src/analysis/smart-money.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger, errorMessage } from '../src/core/logger.ts';
import { WebhookQueue } from '../src/notify/discord-client.ts';
import { sanitize } from '../src/notify/format.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';

function toRecord(row: Readonly<Record<string, unknown>>): TradeRecord | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(String(row.details_json)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if ((d.side !== 'BUY' && d.side !== 'SELL') || typeof d.wallet !== 'string' || typeof d.tokenAmount !== 'number') return null;
  return {
    wallet: d.wallet,
    label: typeof d.walletLabel === 'string' ? d.walletLabel : null,
    chain: String(row.chain),
    token: String(row.token_address),
    symbol: typeof row.token_symbol === 'string' ? row.token_symbol : null,
    side: d.side,
    tokenAmount: d.tokenAmount,
    usdValue: typeof d.usdValue === 'number' ? d.usdValue : null,
    at: Number(row.t_detected),
  };
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const who = (s: WalletStats): string => s.label ?? `${s.wallet.slice(0, 6)}…${s.wallet.slice(-4)}`;

function line(s: WalletStats, rank: number): string {
  const score = s.rankScore === null
    ? `ยังไม่จัดอันดับ (ปิด ${s.closedPositions}/${MIN_CLOSED_FOR_RANK}, ลงทุน ${money(s.closedStakeUsd)}/${money(MIN_STAKE_FOR_RANK_USD)})`
    : `คะแนน ${s.rankScore}`;
  const win = s.winRatePct === null ? '-' : `${s.winRatePct.toFixed(0)}%`;
  const hold = s.avgHoldMinutes === null ? '-' : s.avgHoldMinutes < 120 ? `${s.avgHoldMinutes.toFixed(0)} นาที` : `${(s.avgHoldMinutes / 60).toFixed(1)} ชม.`;
  return `${rank}. ${who(s)} [${s.chain}] ${score} | ชนะ ${win} (${s.wins}/${s.closedPositions}) | กำไรที่ปิดแล้ว ${money(s.realizedPnlUsd)} | ถือเฉลี่ย ${hold} | ซื้อ ${s.buys} ขาย ${s.sells} | ขายได้ ≥2 เท่า ${s.doubledEntries} เหรียญ`;
}

async function post(stats: readonly WalletStats[], days: number): Promise<void> {
  const config = loadConfig();
  const url = config.webhooks.SMART_MONEY_BUY ?? config.defaultWebhook;
  if (!url) throw new Error('No SMART_MONEY_BUY or DEFAULT webhook in .env');
  const queue = new WebhookQueue(url, createLogger('warn', null), 10);
  const body = stats.slice(0, 15).map((s, i) => sanitize(line(s, i + 1), 400)).join('\n');
  const outcome = await queue.send({
    embeds: [{
      title: `🏆 Smart Money Ranking (${days} วันล่าสุด)`,
      description: `${body || 'ยังไม่มีการซื้อขายที่บันทึกไว้'}\n\nคิดจากการซื้อขายจริงที่ระบบบันทึก (FIFO) เฉพาะรายการที่มีราคา USD · ต้องปิดอย่างน้อย ${MIN_CLOSED_FOR_RANK} เหรียญถึงจะจัดอันดับ`.slice(0, 4000),
      color: 0xeab308,
      fields: [],
      timestamp: new Date().toISOString(),
    }],
  });
  process.stdout.write(`Discord: ${outcome.status}\n`);
}

async function main(): Promise<void> {
  const daysArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const days = daysArg === undefined ? 30 : Number(daysArg);
  if (!Number.isFinite(days) || days <= 0) throw new Error('Usage: npm run smartmoney [days] [--post]');
  const repo = createEventRepository(openDatabase(loadConfig().dbPath));
  const trades = repo.walletTrades(Date.now() - days * 86_400_000).flatMap((row) => toRecord(row) ?? []);
  const stats = rankWallets(trades);
  process.stdout.write(`Wallet trades in the last ${days} days: ${trades.length}\n\n`);
  stats.forEach((s, i) => process.stdout.write(`${line(s, i + 1)}${s.unpricedTrades > 0 ? ` | ไม่มีราคา ${s.unpricedTrades}` : ''}\n`));
  if (process.argv.includes('--post')) await post(stats, days);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

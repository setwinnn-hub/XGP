/**
 * Wallet trades recorded in the last N hours, with per-trade latency, plus an independent
 * re-check of every Solana trade: PumpPortal-sourced trades are re-decoded from the raw
 * transaction via RPC and compared (side, token, SOL amount).
 *
 * Usage: npm run trades [hoursBack] [--verify]
 */
import { classifySolanaTx, fetchParsedTransaction } from '../src/chains/solana/solana-trade.ts';
import { loadConfig } from '../src/config.ts';
import { average, percentile, sleep } from '../src/core/util.ts';
import { openDatabase } from '../src/storage/db.ts';

interface Row {
  readonly chain: string; readonly source: string; readonly token: string; readonly symbol: string | null;
  readonly tx: string; readonly details: Record<string, unknown>;
  readonly tChain: number | null; readonly tDetected: number; readonly tDiscord: number | null; readonly delivery: string | null;
}

function load(dbPath: string, sinceMs: number): Row[] {
  const db = openDatabase(dbPath);
  return db.prepare(`SELECT chain, source, token_address, token_symbol, tx_hash, details_json, t_chain, t_detected, t_discord, delivery
    FROM events WHERE kind = 'wallet_trade' AND t_detected >= ? ORDER BY t_detected`).all(sinceMs).map((r) => ({
    chain: String(r.chain), source: String(r.source), token: String(r.token_address),
    symbol: typeof r.token_symbol === 'string' ? r.token_symbol : null, tx: String(r.tx_hash),
    details: JSON.parse(String(r.details_json)) as Record<string, unknown>,
    tChain: typeof r.t_chain === 'number' ? r.t_chain : null, tDetected: Number(r.t_detected),
    tDiscord: typeof r.t_discord === 'number' ? r.t_discord : null, delivery: typeof r.delivery === 'string' ? r.delivery : null,
  }));
}

const sec = (ms: number | null): string => (ms === null ? '   -  ' : `${(ms / 1000).toFixed(2)}s`.padStart(6));

function printRows(rows: readonly Row[]): void {
  for (const r of rows) {
    const d = r.details;
    const usd = typeof d.usdValue === 'number' ? `$${d.usdValue.toFixed(2)}` : 'no-usd';
    process.stdout.write(
      `${r.chain.padEnd(7)} ${r.source.padEnd(11)} ${String(d.side).padEnd(4)} ${String(r.symbol ?? r.token.slice(0, 8)).slice(0, 12).padEnd(12)} ` +
      `${Number(d.quoteAmount).toPrecision(4).padStart(10)} ${String(d.quoteSymbol).padEnd(4)} ${usd.padStart(10)} ` +
      `detect=${sec(r.tChain === null ? null : r.tDetected - r.tChain)} toDiscord=${sec(r.tDiscord === null ? null : r.tDiscord - r.tDetected)} ${r.delivery ?? ''}  ${r.tx.slice(0, 14)}\n`,
    );
  }
}

function printSummary(rows: readonly Row[]): void {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.chain}/${r.source}`, [...(groups.get(`${r.chain}/${r.source}`) ?? []), r]);
  for (const [label, group] of groups) {
    const detect = group.flatMap((r) => (r.tChain === null ? [] : [r.tDetected - r.tChain]));
    const total = group.flatMap((r) => (r.tChain === null || r.tDiscord === null ? [] : [r.tDiscord - r.tChain]));
    process.stdout.write(`${label.padEnd(22)} trades=${group.length} detect avg=${sec(average(detect))} p95=${sec(percentile(detect, 95))} | chain->Discord avg=${sec(average(total))} p95=${sec(percentile(total, 95))} (n=${total.length})\n`);
  }
}

async function verifySolana(rows: readonly Row[], rpcUrl: string): Promise<void> {
  let agree = 0;
  let checked = 0;
  for (const r of rows.filter((x) => x.chain === 'solana').slice(-25)) {
    await sleep(1_500);
    const tx = await fetchParsedTransaction(rpcUrl, r.tx).catch(() => null);
    if (!tx) { process.stdout.write(`  ${r.tx.slice(0, 12)} not fetched (RPC limit)\n`); continue; }
    const result = classifySolanaTx(tx, String(r.details.wallet));
    checked += 1;
    const quote = Number(r.details.quoteAmount);
    const same = result.ok && result.trade.side === r.details.side && result.trade.token === r.token
      && Math.abs(result.trade.quoteAmount - quote) / quote < 0.05;
    if (same) agree += 1;
    const rpcSide = result.ok ? `${result.trade.side} ${result.trade.quoteAmount.toPrecision(4)} SOL` : result.reason;
    process.stdout.write(`  ${same ? 'MATCH   ' : 'MISMATCH'} ${r.source.padEnd(11)} stored=${String(r.details.side)} ${quote.toPrecision(4)} SOL | rpc=${rpcSide}\n`);
  }
  process.stdout.write(`Solana re-check: ${agree}/${checked} match (side, token, SOL within 5%; SOL includes new token-account rent)\n`);
}

async function main(): Promise<void> {
  const hours = Number(process.argv[2] ?? 1);
  const config = loadConfig();
  const rows = load(config.dbPath, Date.now() - hours * 3_600_000);
  process.stdout.write(`Wallet trades in the last ${hours}h: ${rows.length}\n\n`);
  printRows(rows);
  process.stdout.write('\n');
  printSummary(rows);
  if (process.argv.includes('--verify')) await verifySolana(rows, config.solanaRpcUrl);
}

await main();

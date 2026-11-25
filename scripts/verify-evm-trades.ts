/**
 * Independent check of stored EVM wallet trades, using a different method than the bot:
 *   BUY  paid in native coin -> compare with tx.value (what the wallet sent)
 *   SELL paid out in native  -> compare with WETH/WBNB Withdrawal (unwrap) events in the receipt
 * The bot itself uses balance differences, so agreement here is real cross-validation.
 *
 * Usage: node scripts/verify-evm-trades.ts [chain=bsc] [limit=40]
 */
import { createPublicClient, http, type Hash } from 'viem';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { httpUrlFor, loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/storage/db.ts';

const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const TOLERANCE = 0.02;

async function main(): Promise<void> {
  const chainId = process.argv[2] ?? 'bsc';
  const limit = Number(process.argv[3] ?? 40);
  const chain = findEvmChain(chainId) as EvmChainConfig;
  const wrapped = Object.entries(chain.quoteTokens).find(([, s]) => s === 'WBNB' || s === 'WETH')?.[0];
  const client = createPublicClient({ transport: http(httpUrlFor(chain), { timeout: 20_000 }) });
  const db = openDatabase(loadConfig().dbPath);
  const rows = db.prepare(`SELECT tx_hash, details_json FROM events WHERE kind = 'wallet_trade' AND chain = ?
    ORDER BY t_detected DESC LIMIT ?`).all(chainId, limit);

  let checked = 0;
  let agree = 0;
  for (const row of rows) {
    const d = JSON.parse(String(row.details_json)) as { side: string; quoteSymbol: string; quoteAmount: number };
    if (d.quoteSymbol !== chain.quoteTokens['0x0000000000000000000000000000000000000000']) continue;
    const hash = String(row.tx_hash) as Hash;
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const independent = d.side === 'BUY'
      ? Number(tx.value) / 1e18
      : receipt.logs
          .filter((l) => l.address.toLowerCase() === wrapped && l.topics[0] === WITHDRAWAL_TOPIC)
          .reduce((sum, l) => sum + Number(BigInt(l.data)) / 1e18, 0);
    const method = d.side === 'BUY' ? 'tx.value' : 'unwrap events';
    if (independent === 0) {
      process.stdout.write(`SKIP     ${d.side.padEnd(4)} ${d.quoteAmount.toPrecision(5).padStart(10)} | ${method} = 0 (route without native leg)  ${hash.slice(0, 14)}\n`);
      continue;
    }
    checked += 1;
    const diff = Math.abs(independent - d.quoteAmount) / independent;
    if (diff <= TOLERANCE) agree += 1;
    process.stdout.write(`${diff <= TOLERANCE ? 'MATCH   ' : 'MISMATCH'} ${d.side.padEnd(4)} bot=${d.quoteAmount.toPrecision(5).padStart(10)} ${method}=${independent.toPrecision(5).padStart(10)} (${(diff * 100).toFixed(2)}%)  ${hash.slice(0, 14)}\n`);
  }
  process.stdout.write(`\n${chainId}: ${agree}/${checked} trades match the independent method within ${TOLERANCE * 100}%\n`);
}

await main();

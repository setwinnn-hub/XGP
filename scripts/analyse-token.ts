/**
 * Analyse one token now and print its opportunity score, risk level and reasons.
 * Usage: npm run analyse -- <chain> <token address>
 *   chain: solana | ethereum | base | bsc
 */
import { AnalysisEngine } from '../src/analysis/analysis-engine.ts';
import { fetchSolanaMint } from '../src/analysis/solana-mint.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/core/logger.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { isChainId } from '../src/wallets/wallet-repo.ts';

async function main(): Promise<void> {
  const [chain, token] = process.argv.slice(2);
  if (!chain || !token || !isChainId(chain)) throw new Error('Usage: npm run analyse -- <solana|ethereum|base|bsc> <token address>');
  const config = loadConfig();
  const repo = createEventRepository(openDatabase(config.dbPath));
  const engine = new AnalysisEngine({
    config: config.analysis, repo, ingest: () => false, logger: silentLogger,
    fetchSolanaMint: (mint) => fetchSolanaMint(config.solanaRpcUrl, mint),
  });
  const { market, score, smartBuyers } = await engine.analyse({ chain, token, symbol: null, name: null });
  const m = market;
  process.stdout.write(`\n${chain} ${token}\n`);
  process.stdout.write(m ? `DEX ${m.dexId} | liquidity ${m.liquidityUsd ?? '-'} | mcap ${m.marketCapUsd ?? '-'} | vol1h ${m.volumeUsd.h1} | buys/sells 1h ${m.txnsH1.buys}/${m.txnsH1.sells} | 1h ${m.priceChangePct.h1 ?? '-'}%\n` : 'No DexScreener market data\n');
  process.stdout.write(`Followed wallets that bought: ${smartBuyers}\n`);
  process.stdout.write(`\nOPPORTUNITY ${score.opportunity}/100 (raw ${score.rawOpportunity})   RISK ${score.risk}\n`);
  for (const p of score.positives) process.stdout.write(`  + ${p}\n`);
  for (const r of score.risks) process.stdout.write(`  ! ${r}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

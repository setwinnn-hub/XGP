/**
 * Market cap verification for one token: on-chain supply vs DexScreener, in THB.
 * Usage: npm run mcap -- <solana|ethereum|base|bsc> <token address>
 */
import { fetchMarket } from '../src/analysis/market.ts';
import { loadConfig } from '../src/config.ts';
import { errorMessage } from '../src/core/logger.ts';
import { fetchFxRate } from '../src/enrich/prices.ts';
import { rangePosition, verifyMarketCap } from '../src/gem/market-cap.ts';
import { createSettingsRepository } from '../src/gem/settings.ts';
import { fetchOnchainSupply } from '../src/gem/supply.ts';
import { openDatabase } from '../src/storage/db.ts';
import { isChainId } from '../src/wallets/wallet-repo.ts';

const baht = (n: number | null): string => (n === null ? '-' : `฿${Math.round(n).toLocaleString('en-US')}`);
const dollars = (n: number | null): string => (n === null ? '-' : `$${Math.round(n).toLocaleString('en-US')}`);

async function main(): Promise<void> {
  const [chain, token] = process.argv.slice(2);
  if (!chain || !token || !isChainId(chain) || chain === 'offchain') throw new Error('Usage: npm run mcap -- <solana|ethereum|base|bsc> <token>');
  const config = loadConfig();
  const settings = createSettingsRepository(openDatabase(config.dbPath)).get();
  const [market, supply, fx] = await Promise.all([
    fetchMarket(chain, token).catch(() => null),
    fetchOnchainSupply(chain, token, config.solanaRpcUrl).catch((e: unknown) => { process.stdout.write(`supply error: ${errorMessage(e)}\n`); return null; }),
    fetchFxRate().catch(() => null),
  ]);
  const r = verifyMarketCap(market, supply, fx, Date.now());
  process.stdout.write(`\n${chain} ${token}\n`);
  process.stdout.write(`Status: ${r.status} — ${r.reason}\nMethod: ${r.method}\nSources: ${r.sources.join(', ')}\n`);
  process.stdout.write(`FX: ${fx ? `${fx.thbPerUsd.toFixed(3)} THB/USD @ ${new Date(fx.at).toISOString()} (${fx.source})` : 'unavailable'}\n`);
  process.stdout.write(`Price: ${r.priceUsd ?? '-'} USD | total supply ${r.totalSupply ?? '-'} | burned ${supply?.burned ?? '-'} | circulating ${r.circulatingSupply ?? '-'} | decimals ${supply?.decimals ?? '-'}\n`);
  process.stdout.write(`Circulating MCAP: ${baht(r.circulatingMcapThb)} (${dollars(r.circulatingMcapUsd)}) | FDV: ${baht(r.fdvThb)} (${dollars(r.fdvUsd)})\n`);
  process.stdout.write(`DexScreener says: mcap ${dollars(r.dexMarketCapUsd)} | fdv ${dollars(r.dexFdvUsd)}\n`);
  process.stdout.write(`Range ${baht(settings.minMarketCapThb)}–${baht(settings.maxMarketCapThb)}: ${rangePosition(r, settings.minMarketCapThb, settings.maxMarketCapThb)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

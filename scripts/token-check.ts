/**
 * Liquidity, slippage and security check for one token (Early Gem Stage 8).
 * Usage: npm run tokencheck -- <ethereum|base|bsc|solana> <token> [tradeThb]
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { fetchMarket } from '../src/analysis/market.ts';
import { fetchSecurity } from '../src/analysis/security.ts';
import { findEvmChain } from '../src/chains/evm/chains.ts';
import { httpUrlFor, loadConfig } from '../src/config.ts';
import { errorMessage } from '../src/core/logger.ts';
import { fetchFxRate } from '../src/enrich/prices.ts';
import { buyerWindows } from '../src/gem/buyer-stats.ts';
import { fetchHoneypot } from '../src/gem/honeypot.ts';
import { assessLiquidity } from '../src/gem/liquidity.ts';
import { fetchPairReserves, type PairReserves } from '../src/gem/pool-reserves.ts';
import { assessSecurity } from '../src/gem/security-engine.ts';
import { createSettingsRepository } from '../src/gem/settings.ts';
import { createSwapStore } from '../src/gem/swap-store.ts';
import { watchFor } from '../src/gem/watch-policy.ts';
import { openDatabase } from '../src/storage/db.ts';
import { isChainId } from '../src/wallets/wallet-repo.ts';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const pct = (n: number | null, d = 2): string => (n === null ? '-' : `${n.toFixed(d)}%`);
const baht = (n: number | null): string => (n === null ? '-' : `฿${Math.round(n).toLocaleString('en-US')}`);
const ICON = { PASS: '✅ ผ่าน', WARN: '⚠️  ระวัง', FAIL: '❌ ไม่ผ่าน', UNKNOWN: '❔ ตรวจไม่ได้' } as const;

async function main(): Promise<void> {
  const [chain, token, tradeArg] = process.argv.slice(2);
  if (!chain || !token || !isChainId(chain) || chain === 'offchain') throw new Error('Usage: npm run tokencheck -- <ethereum|base|bsc|solana> <token> [tradeThb]');
  const db = openDatabase(loadConfig().dbPath);
  const saved = createSettingsRepository(db).get();
  const trade = tradeArg ? Number(tradeArg) : saved.testTradeThb;
  if (!Number.isFinite(trade) || trade <= 0) throw new Error('tradeThb must be a positive number');
  const settings = { ...saved, testTradeThb: trade };

  const [market, goplus, honeypot, fx] = await Promise.all([
    fetchMarket(chain, token).catch(() => null),
    fetchSecurity(chain, token).catch((e: unknown) => { out(`GoPlus error: ${errorMessage(e)}`); return null; }),
    fetchHoneypot(chain, token).catch((e: unknown) => { out(`honeypot.is error: ${errorMessage(e)}`); return null; }),
    fetchFxRate().catch(() => null),
  ]);
  const watch = market ? watchFor({ chain, token, symbol: null, name: null }, { ...market, marketCapUsd: null, fdvUsd: null }, Date.now()) : null;
  const evm = findEvmChain(chain);
  let reserves: PairReserves | null = null;
  if (evm && watch?.poolKind === 'pair') {
    const client = createPublicClient({ transport: http(httpUrlFor(evm), { timeout: 15_000 }) }) as PublicClient;
    reserves = (await fetchPairReserves(client, [{ pair: watch.pool, token }]).catch(() => new Map<string, PairReserves>())).get(watch.pool) ?? null;
  }

  // Activity: the bot's own swap records when it watches this token, else DexScreener's hour.
  const store = createSwapStore(db);
  const stored = store.findWatch(chain, token) ?? store.findWatch(chain, token.toLowerCase());
  const cursor = store.cursor(chain);
  const w = stored && cursor ? buyerWindows(store.swaps(chain, stored.token, Date.now() - 2 * 3_600_000), cursor.updatedAt, Math.max(stored.addedAt, cursor.coverageSince)) : null;
  const w60 = w?.find((x) => x.minutes === 60);
  const w15 = w?.find((x) => x.minutes === 15);
  const liquidity = assessLiquidity({
    market, reserves, thbPerUsd: fx?.thbPerUsd ?? null, settings, now: Date.now(), history: [],
    poolFee: goplus?.extra?.poolFees[watch?.pool ?? ''] ?? null,
    activity: {
      buys60m: w60?.complete ? w60.buys : null, uniqueBuyers60m: w60?.complete ? w60.uniqueBuyers : null,
      independentBuyers15m: w15?.complete ? w15.uniqueBuyers : null,
      buys15m: w15?.complete ? w15.buys : null, uniqueBuyers15m: w15?.complete ? w15.uniqueBuyers : null, dexTxnsH1: market ? market.txnsH1.buys + market.txnsH1.sells : null,
    },
  });
  const security = assessSecurity({ chain, poolKind: watch?.poolKind ?? 'pair', goplus, honeypot, liquidityFlags: liquidity.flags });

  out(`\n${chain} ${token} | pool ${market?.pairAddress ?? '-'} (${market?.dexId ?? '-'}, ${watch?.poolKind ?? '-'})`);
  out(`\nLIQUIDITY  activity ${liquidity.activity} | liquidity ${liquidity.liquidity}`);
  out(`  pool value ${baht(liquidity.liquidityThb)} ($${Math.round(liquidity.liquidityUsd ?? 0).toLocaleString('en-US')}) from ${liquidity.liquiditySource} | exit liquidity ${baht(liquidity.exitLiquidityThb)} | pool age ${liquidity.poolAgeMin === null ? '-' : `${(liquidity.poolAgeMin / 60).toFixed(1)} h`}`);
  out(`  trade ${baht(trade)}: buy slippage ${pct(liquidity.buySlippagePct)} | sell slippage ${pct(liquidity.sellSlippagePct)} (${liquidity.slippageMethod}${goplus?.extra?.poolFees[watch?.pool ?? ''] !== undefined ? `, pool fee ${((goplus?.extra?.poolFees[watch?.pool ?? ''] ?? 0) * 100).toFixed(2)}%` : ''})`);
  if (reserves && market?.liquidityQuote) out(`  on-chain quote reserve ${reserves.quoteReserve.toFixed(4)} vs DexScreener ${market.liquidityQuote.toFixed(4)}`);
  for (const r of liquidity.reasons) out(`  - ${r}`);
  if (liquidity.flags.length > 0) out(`  flags: ${liquidity.flags.join(', ')}`);

  out(`\nSECURITY  ${security.level}${security.suppressGemAlert ? ' (Gem alert suppressed)' : ''}`);
  out(`  sources: GoPlus ${goplus ? 'answered' : 'no data'} | honeypot.is ${honeypot?.status ?? 'not supported'}`);
  for (const c of security.checks) out(`  ${ICON[c.status]} | ${c.label}${c.detail ? ` — ${c.detail}` : ''}${c.sources.length ? ` [${c.sources.join(', ')}]` : ''}`);
  for (const r of security.reasons) out(`  > ${r}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

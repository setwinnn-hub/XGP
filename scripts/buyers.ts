/**
 * Unique buyers of one EVM token per 1/5/15/60-minute window and its accumulation / pre-pump
 * verdict, read from chain logs, next to DexScreener's own transaction counts for the same pool.
 *
 * Usage:
 *   npm run buyers -- <ethereum|base|bsc> <token> [minutes=60]   read the last N minutes on-chain (writes nothing)
 *   npm run buyers -- <ethereum|base|bsc> <token> --stored       what the running bot has collected
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { fetchMarket } from '../src/analysis/market.ts';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { httpUrlFor, loadConfig } from '../src/config.ts';
import { createLogger, errorMessage } from '../src/core/logger.ts';
import { buyerWindows, type WindowStats } from '../src/gem/buyer-stats.ts';
import { detectAccumulation, type PriceContext } from '../src/gem/accumulation.ts';
import { createWalletRepository } from '../src/wallets/wallet-repo.ts';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { createSwapCollector, tokenCoverageSince } from '../src/gem/swap-collector.ts';
import { createSwapStore, type SwapRow } from '../src/gem/swap-store.ts';
import { watchFor } from '../src/gem/watch-policy.ts';
import { openDatabase } from '../src/storage/db.ts';
import { sleep } from '../src/core/util.ts';

const CHUNK = 500n;
const MAX_MINUTES = 120;
/** Free public RPCs rate-limit bursts; the running bot shares the same limit. */
const CHUNK_PAUSE_MS = 400;
const RETRY_PAUSE_MS = 5_000;

interface DexCounts { readonly m5: string; readonly h1: string }

async function dexCounts(chain: string, token: string, pair: string): Promise<DexCounts | null> {
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chain}/${token}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const pairs = (await res.json()) as { pairAddress?: string; txns?: Record<string, { buys?: number; sells?: number }> }[];
  const p = Array.isArray(pairs) ? pairs.find((x) => x.pairAddress?.toLowerCase() === pair.toLowerCase()) : undefined;
  const f = (w: string): string => `${p?.txns?.[w]?.buys ?? '-'} buys / ${p?.txns?.[w]?.sells ?? '-'} sells`;
  return p ? { m5: f('m5'), h1: f('h1') } : null;
}

function printWindows(windows: readonly WindowStats[]): void {
  const pct = (n: number | null): string => (n === null ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`);
  process.stdout.write('window | complete | buys | sells | unique buyers | new | returning | multi-buy | growth vs prev\n');
  for (const w of windows) {
    process.stdout.write(`${String(w.minutes).padStart(4)}m | ${w.complete ? 'yes' : 'NO '}      | ${w.buys} | ${w.sells} | ${w.uniqueBuyers} | ${w.newBuyers} | ${w.returningBuyers} | ${w.multiBuyWallets} | ${pct(w.uniqueBuyersGrowthPct)}\n`);
  }
}

function smartWallets(chainId: string): ReadonlySet<string> {
  const repo = createWalletRepository(openDatabase(loadConfig().dbPath));
  return new Set(repo.list().filter((w) => w.chain === chainId).map((w) => w.address.toLowerCase()));
}

const priceOf = (m: MarketSnapshot | null): PriceContext | null => (m ? { changeM5Pct: m.priceChangePct.m5, changeH1Pct: m.priceChangePct.h1 } : null);

/** Accumulation / pre-pump verdict on the same rows (Stage 7). */
function printAccumulation(chainId: string, rows: readonly SwapRow[], now: number, coverageSince: number, market: MarketSnapshot | null): void {
  const r = detectAccumulation({ swaps: rows, now, coverageSince, smartWallets: smartWallets(chainId), price: priceOf(market) });
  const m = r.metrics;
  const f = (n: number | null, d = 2): string => (n === null ? '-' : n.toFixed(d));
  process.stdout.write(`
Accumulation: ${r.status} (confidence ${r.confidence})
`);
  for (const reason of r.reasons) process.stdout.write(`  - ${reason}
`);
  process.stdout.write(`  independent buyers 5m/15m ${m.independentBuyers5m}/${m.independentBuyers15m} | baseline/5m ${f(m.baselinePer5m, 1)} | acceleration ${f(m.acceleration, 1)}x
`);
  process.stdout.write(`  buy pressure 5m/15m ${f(m.buyPressure5m)}/${f(m.buyPressure15m)} | holders (bought, not sold) 15m ${m.netAccumulators15m} | repeat buyers ${m.repeatBuyers15m}
`);
  process.stdout.write(`  clustered share 15m ${(m.clusteredShare15m * 100).toFixed(0)}% | clusters ${r.clusters.length} | smart money buyers 60m ${m.smartMoneyBuyers60m} | price 1h ${f(m.priceChangeH1Pct, 0)}%
`);
  for (const c of r.clusters.slice(0, 5)) process.stdout.write(`  cluster of ${c.wallets.length}: ${c.evidence.join(', ')} (${c.wallets.slice(0, 3).map((w) => w.slice(0, 10)).join(', ')}${c.wallets.length > 3 ? ', ...' : ''})
`);
}

/** First block at or after `targetMs`, found by sampling the average block time. */
async function blockAt(client: PublicClient, head: bigint, headMs: number, targetMs: number): Promise<bigint> {
  const sample = 1_000n;
  const older = await client.getBlock({ blockNumber: head - sample });
  const msPerBlock = (headMs - Number(older.timestamp) * 1000) / Number(sample);
  return head - BigInt(Math.ceil((headMs - targetMs) / msPerBlock));
}

async function fromChain(chain: EvmChainConfig, token: string, minutes: number): Promise<void> {
  const market = await fetchMarket(chain.id, token);
  if (!market?.pairAddress) throw new Error('DexScreener has no pair for this token');
  const now = Date.now();
  const watch = watchFor({ chain: chain.id, token, symbol: null, name: null }, { ...market, marketCapUsd: null, fdvUsd: null }, now);
  if (!watch) throw new Error(`pool ${market.pairAddress} is not a supported EVM pool`);
  const client = createPublicClient({ transport: http(httpUrlFor(chain), { timeout: 20_000 }) }) as PublicClient;
  const config = loadConfig();
  const collector = createSwapCollector({ chain, store: createSwapStore(openDatabase(config.dbPath)), logger: createLogger('warn', null) });
  const head = (await client.getBlockNumber()) - 1n;
  const headMs = Number((await client.getBlock({ blockNumber: head })).timestamp) * 1000;
  const from = await blockAt(client, head, headMs, headMs - minutes * 60_000);
  const fromMs = Number((await client.getBlock({ blockNumber: from })).timestamp) * 1000;
  process.stdout.write(`\n${chain.id} ${token} | pool ${market.pairAddress} (${market.dexId}, ${watch.poolKind})\n`);
  process.stdout.write(`Reading blocks ${from}–${head} (${((headMs - fromMs) / 60_000).toFixed(1)} min)...\n`);
  const started = Date.now();
  let rows: SwapRow[] = [];
  for (let b = from; b <= head; b += CHUNK) {
    const to = b + CHUNK - 1n < head ? b + CHUNK - 1n : head;
    const read = (): Promise<SwapRow[]> => collector.collectRange(client, [watch], b, to);
    const chunk = await read().catch(async (error: unknown) => {
      process.stdout.write(`  blocks ${b}-${to}: ${errorMessage(error).split('\n')[0]} — retrying once\n`);
      await sleep(RETRY_PAUSE_MS);
      return read();
    });
    rows = [...rows, ...chunk];
    await sleep(CHUNK_PAUSE_MS);
  }
  process.stdout.write(`${rows.length} netted swaps from ${new Set(rows.map((r) => r.wallet)).size} wallets in ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`);
  printWindows(buyerWindows(rows, headMs, fromMs));
  printAccumulation(chain.id, rows, headMs, fromMs, market);
  const dex = await dexCounts(chain.id, token, market.pairAddress).catch(() => null);
  process.stdout.write(`\nDexScreener (same pool, counts swaps not wallets): m5 ${dex?.m5 ?? '-'} | h1 ${dex?.h1 ?? '-'}\n`);
}

async function fromStore(chainId: EvmChainConfig['id'], token: string): Promise<void> {
  const store = createSwapStore(openDatabase(loadConfig().dbPath));
  const watch = store.findWatch(chainId, token) ?? store.findWatch(chainId, token.toLowerCase());
  const cursor = store.cursor(chainId);
  if (!watch || !cursor) throw new Error('the bot is not watching this token (it is added after the token is analysed)');
  const now = Date.now();
  const rows = store.swaps(chainId, watch.token, now - 2 * 60 * 60_000);
  process.stdout.write(`\n${chainId} ${watch.token} (${watch.symbol ?? '?'}) watched until ${new Date(watch.expiresAt).toISOString()} | cursor block ${cursor.block}\n\n`);
  const asOf = Math.min(now, cursor.updatedAt);
  const coverage = tokenCoverageSince(watch, cursor.coverageSince);
  printWindows(buyerWindows(rows, asOf, coverage));
  const market = await fetchMarket(chainId, watch.token).catch(() => null);
  printAccumulation(chainId, rows, asOf, coverage, market);
}

async function main(): Promise<void> {
  const [chainId, token, arg] = process.argv.slice(2);
  const chain = chainId ? findEvmChain(chainId) : null;
  if (!chain || !token || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('Usage: npm run buyers -- <ethereum|base|bsc> <token> [minutes|--stored]');
  if (arg === '--stored') return fromStore(chain.id, token);
  const minutes = arg ? Number(arg) : 60;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new Error(`minutes must be 1–${MAX_MINUTES}`);
  await fromChain(chain, token, minutes);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

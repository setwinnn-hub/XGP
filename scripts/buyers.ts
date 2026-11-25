/**
 * Unique buyers of one EVM token per 1/5/15/60-minute window, read from chain logs, next to
 * DexScreener's own transaction counts for the same pool.
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
  const dex = await dexCounts(chain.id, token, market.pairAddress).catch(() => null);
  process.stdout.write(`\nDexScreener (same pool, counts swaps not wallets): m5 ${dex?.m5 ?? '-'} | h1 ${dex?.h1 ?? '-'}\n`);
}

function fromStore(chainId: string, token: string): void {
  const store = createSwapStore(openDatabase(loadConfig().dbPath));
  const watch = store.findWatch(chainId, token) ?? store.findWatch(chainId, token.toLowerCase());
  const cursor = store.cursor(chainId);
  if (!watch || !cursor) throw new Error('the bot is not watching this token (it is added after the token is analysed)');
  const now = Date.now();
  const rows = store.swaps(chainId, watch.token, now - 2 * 60 * 60_000);
  process.stdout.write(`\n${chainId} ${watch.token} (${watch.symbol ?? '?'}) watched until ${new Date(watch.expiresAt).toISOString()} | cursor block ${cursor.block}\n\n`);
  printWindows(buyerWindows(rows, now, tokenCoverageSince(watch, cursor.coverageSince)));
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

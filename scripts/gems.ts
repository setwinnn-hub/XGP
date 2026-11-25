/**
 * Early Gem classifications as the running bot last scored them.
 * Usage:
 *   npm run gems                      all tokens scored in the last 2 hours, best first
 *   npm run gems -- <chain> <token>   one token: categories, gate reasons, history
 */
import { loadConfig } from '../src/config.ts';
import { errorMessage } from '../src/core/logger.ts';
import { createScoreStore, type ScoreRecord } from '../src/gem/score-store.ts';
import { openDatabase } from '../src/storage/db.ts';

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const baht = (n: number | null | undefined): string => (n === null || n === undefined ? '-' : `฿${Math.round(n).toLocaleString('en-US')}`);
const ORDER = ['HIGH_POTENTIAL', 'EARLY_WATCH', 'LOW_ACTIVITY', 'HIGH_RISK', 'REJECTED'];
const ago = (at: number): string => `${Math.round((Date.now() - at) / 60_000)}m ago`;

function listAll(records: readonly ScoreRecord[]): void {
  out(`\n${records.length} tokens scored in the last 2 hours (score is not a price prediction)\n`);
  for (const cls of ORDER) {
    const group = records.filter((r) => r.gem.classification === cls);
    if (group.length === 0) continue;
    out(`== ${cls} (${group.length})`);
    for (const r of group.slice(0, 15)) {
      out(`  ${String(r.gem.score).padStart(5)} | conf ${String(r.gem.confidence).padStart(4)}% | ${r.chain.padEnd(8)} ${(r.symbol ?? '?').slice(0, 12).padEnd(12)} ${r.token} | mcap ${baht(r.marketCap?.circulatingMcapThb)} ${r.marketCap?.status ?? 'UNVERIFIED'} | sec ${r.securityLevel} | ${ago(r.at)}`);
      if (r.gem.gateReasons.length > 0) out(`        ${r.gem.gateReasons.slice(0, 2).join(' ; ')}`);
    }
  }
}

function detail(store: ReturnType<typeof createScoreStore>, chain: string, token: string): void {
  const r = store.latest(chain, token) ?? store.latest(chain, token.toLowerCase());
  if (!r) throw new Error('no score yet for this token (it must be watched and evaluated by the running bot)');
  out(`\n${r.chain} ${r.symbol ?? '?'} ${r.token} | ${ago(r.at)}`);
  out(`CLASS ${r.gem.classification} | Early Gem Score ${r.gem.score}/100 | Data confidence ${r.gem.confidence}%`);
  out(`Market cap ${baht(r.marketCap?.circulatingMcapThb)} (${r.marketCap?.status ?? 'UNVERIFIED'}, ${r.rangePosition}) | Security ${r.securityLevel} | Liquidity ${r.liquidity} | Activity ${r.activity} | Accumulation ${r.accumulation}`);
  for (const reason of r.gem.gateReasons) out(`  gate: ${reason}`);
  out('\ncategory               weight  points  evidence  note');
  for (const c of r.gem.categories) {
    out(`  ${c.category.padEnd(21)} ${String(c.weight).padStart(5)}  ${c.points.toFixed(1).padStart(6)}  ${c.evidence ? 'yes     ' : 'NO      '}  ${c.note}`);
  }
  out('\nhistory (newest first)');
  for (const h of store.history(r.chain, r.token, 10)) out(`  ${new Date(h.at).toISOString()}  ${h.classification.padEnd(15)} ${h.score} (conf ${h.confidence}%)`);
}

function main(): void {
  const store = createScoreStore(openDatabase(loadConfig().dbPath));
  const [chain, token] = process.argv.slice(2);
  if (chain && token) return detail(store, chain, token);
  listAll(store.current(Date.now() - 2 * 3_600_000));
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}

/**
 * Latency report from recorded events.
 * Usage: npm run report [hoursBack]
 *
 *   detect   = t_detected - t_chain   (chain -> our process; block times are whole seconds, so +/-1s)
 *   pipeline = t_discord  - t_detected (our process -> Discord server receipt)
 *   total    = t_discord  - t_chain
 */
import { average, percentile } from '../src/core/util.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository, type LatencyRow } from '../src/storage/event-repo.ts';

type Metric = (row: LatencyRow) => number | null;

const METRICS: ReadonlyArray<readonly [string, Metric]> = [
  ['detect', (r) => (r.tChain === null ? null : r.tDetected - r.tChain)],
  ['pipeline', (r) => (r.tDiscord === null ? null : r.tDiscord - r.tDetected)],
  ['total', (r) => (r.tChain === null || r.tDiscord === null ? null : r.tDiscord - r.tChain)],
];

function fmt(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(2)}s`;
}

function summarize(label: string, rows: readonly LatencyRow[]): string {
  const parts = METRICS.map(([name, metric]) => {
    const values = rows.map(metric).filter((v): v is number => v !== null);
    if (values.length === 0) return `${name}: n=0`;
    return `${name}: n=${values.length} avg=${fmt(average(values))} p50=${fmt(percentile(values, 50))} p95=${fmt(percentile(values, 95))}`;
  });
  return `${label.padEnd(26)} events=${String(rows.length).padStart(6)} | ${parts.join(' | ')}`;
}

function main(): void {
  const hours = Number(process.argv[2] ?? 24);
  const config = loadConfig();
  const repo = createEventRepository(openDatabase(config.dbPath));
  const rows = repo.latencyRows(Date.now() - hours * 3_600_000);
  const groups = new Map<string, LatencyRow[]>();
  for (const row of rows) {
    const label = `${row.source}/${row.kind}`;
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  const deliveries = new Map<string, number>();
  for (const row of rows) deliveries.set(row.delivery ?? 'pending', (deliveries.get(row.delivery ?? 'pending') ?? 0) + 1);

  process.stdout.write(`Events in the last ${hours}h: ${rows.length}\n`);
  process.stdout.write(`Delivery: ${JSON.stringify(Object.fromEntries(deliveries))}\n\n`);
  for (const [label, group] of [...groups.entries()].sort()) process.stdout.write(`${summarize(label, group)}\n`);
  process.stdout.write(`\n${summarize('ALL', rows)}\n`);
}

main();

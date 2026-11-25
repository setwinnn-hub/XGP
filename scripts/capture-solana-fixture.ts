/**
 * Saves real, recent swap transactions of a public Solana wallet as test fixtures
 * (test/fixtures/solana-<side>.json). Fixtures are raw RPC output, not hand-written.
 *
 * Usage: node scripts/capture-solana-fixture.ts <wallet>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { classifySolanaTx, fetchParsedTransaction, type ParsedSolanaTx } from '../src/chains/solana/solana-trade.ts';
import { loadConfig } from '../src/config.ts';
import { sleep } from '../src/core/util.ts';

async function signaturesOf(rpcUrl: string, wallet: string): Promise<string[]> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [wallet, { limit: 60 }] }),
  });
  const body = (await response.json()) as { result?: Array<{ signature: string; err: unknown }> };
  return (body.result ?? []).filter((s) => s.err === null).map((s) => s.signature);
}

async function main(): Promise<void> {
  const wallet = process.argv[2];
  if (!wallet) throw new Error('Usage: node scripts/capture-solana-fixture.ts <wallet>');
  const { solanaRpcUrl } = loadConfig();
  const wanted = new Set(['BUY', 'SELL']);
  mkdirSync('test/fixtures', { recursive: true });
  for (const signature of await signaturesOf(solanaRpcUrl, wallet)) {
    if (wanted.size === 0) break;
    await sleep(1_200);
    const tx: ParsedSolanaTx | null = await fetchParsedTransaction(solanaRpcUrl, signature).catch((error: unknown) => {
      process.stdout.write(`  ${signature.slice(0, 12)}… fetch failed: ${String(error)}\n`);
      return null;
    });
    if (!tx) continue;
    const result = classifySolanaTx(tx, wallet);
    if (!result.ok) process.stdout.write(`  ${signature.slice(0, 12)}… skipped: ${result.reason}\n`);
    if (!result.ok || !wanted.has(result.trade.side)) continue;
    wanted.delete(result.trade.side);
    const file = `test/fixtures/solana-${result.trade.side.toLowerCase()}.json`;
    writeFileSync(file, JSON.stringify({ wallet, signature, expected: result.trade, tx }, null, 2));
    process.stdout.write(`${file}: ${JSON.stringify(result.trade)}\n`);
  }
}

await main();

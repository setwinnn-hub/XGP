/**
 * Completeness check: did the live subscription miss any new pairs?
 * For each EVM chain, takes the block range the bot was running for, re-reads every factory
 * event in that range with eth_getLogs (ground truth), and compares with what was stored.
 *
 * Usage: npm run check:evm [hoursBack]
 */
import { createPublicClient, http } from 'viem';
import type { EvmChainConfig } from '../src/chains/evm/chains.ts';
import { factoryEventFor } from '../src/chains/evm/factory-events.ts';
import { pairSides } from '../src/chains/evm/normalize.ts';
import { httpUrlFor, loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';

const CHUNK = 500n;

async function groundTruthKeys(chain: EvmChainConfig, fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const client = createPublicClient({ transport: http(httpUrlFor(chain), { timeout: 20_000 }) });
  const keys = new Set<string>();
  for (const factory of chain.factories) {
    for (let from = fromBlock; from <= toBlock; from += CHUNK) {
      const to = from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n;
      const logs = await client.getLogs({ address: factory.address, event: factoryEventFor(factory.kind), fromBlock: from, toBlock: to });
      for (const log of logs) {
        const args = (log.args ?? {}) as Readonly<Record<string, unknown>>;
        const sides = pairSides({ chain, factory, args, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, detectedAt: 0 });
        if (sides) keys.add(`${chain.id}:${log.transactionHash}:${log.logIndex}`);
      }
    }
  }
  return keys;
}

async function main(): Promise<void> {
  const hours = Number(process.argv[2] ?? 24);
  const config = loadConfig();
  const repo = createEventRepository(openDatabase(config.dbPath));
  for (const chain of config.evmChains) {
    const stored = repo.pairEventBlocks(chain.id, Date.now() - hours * 3_600_000);
    const blocks = stored.map((s) => s.blockNumber).filter((b): b is number => b !== null);
    if (blocks.length === 0) {
      process.stdout.write(`${chain.id}: no stored events, nothing to compare\n`);
      continue;
    }
    const from = BigInt(Math.min(...blocks));
    const to = BigInt(Math.max(...blocks));
    const truth = await groundTruthKeys(chain, from, to);
    const storedKeys = new Set(stored.map((s) => s.key));
    const missed = [...truth].filter((key) => !storedKeys.has(key));
    const extra = [...storedKeys].filter((key) => !truth.has(key));
    process.stdout.write(
      `${chain.id}: blocks ${from}-${to} | on-chain ${truth.size} | stored ${storedKeys.size} | missed ${missed.length} | not on chain ${extra.length}\n`,
    );
    for (const key of missed.slice(0, 5)) process.stdout.write(`  missed ${key}\n`);
  }
}

await main();

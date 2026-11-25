/**
 * Checks every configured EVM factory against the live chain: queries recent blocks for
 * its pair/pool-created event. A factory with zero events is either wrong or idle and
 * must be checked by hand before it is trusted.
 *
 * Usage: npm run verify:evm [blocksBack]
 */
import { createPublicClient, http } from 'viem';
import { EVM_CHAINS, type EvmChainConfig, type DexFactory } from '../src/chains/evm/chains.ts';
import { factoryEventFor } from '../src/chains/evm/factory-events.ts';
import { httpUrlFor } from '../src/config.ts';

const DEFAULT_BLOCKS_BACK = 2_000n;
const CHUNK = 500n;

interface FactoryResult {
  readonly chain: string;
  readonly factory: string;
  readonly events: number;
  readonly error?: string;
}

async function countEvents(chain: EvmChainConfig, factory: DexFactory, blocksBack: bigint): Promise<FactoryResult> {
  const client = createPublicClient({ transport: http(httpUrlFor(chain), { timeout: 20_000 }) });
  try {
    const latest = await client.getBlockNumber();
    let total = 0;
    for (let from = latest - blocksBack; from <= latest; from += CHUNK) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const logs = await client.getLogs({ address: factory.address, event: factoryEventFor(factory.kind), fromBlock: from, toBlock: to });
      total += logs.length;
    }
    return { chain: chain.id, factory: factory.name, events: total };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? 'error' : 'error';
    return { chain: chain.id, factory: factory.name, events: 0, error: message };
  }
}

async function main(): Promise<void> {
  const blocksBack = BigInt(process.argv[2] ?? DEFAULT_BLOCKS_BACK);
  const jobs = EVM_CHAINS.flatMap((chain) => chain.factories.map((factory) => countEvents(chain, factory, blocksBack)));
  const results = await Promise.all(jobs);
  process.stdout.write(`Last ${blocksBack} blocks per chain\n`);
  for (const r of results) {
    const status = r.error ? `ERROR ${r.error}` : r.events > 0 ? 'OK' : 'NO EVENTS';
    process.stdout.write(`${r.chain.padEnd(9)} ${r.factory.padEnd(16)} ${String(r.events).padStart(5)}  ${status}\n`);
  }
}

await main();

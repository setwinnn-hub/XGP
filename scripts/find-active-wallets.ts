/**
 * Finds currently active, public trader wallets from real chain data, to use as test
 * wallets for wallet tracking. Nothing is invented: every address comes from recent txs.
 *
 *   Solana: fee payers of recent Pump.fun program transactions.
 *   EVM:    senders of swaps through well-known DEX routers in recent blocks.
 *
 * Usage: npm run find:wallets
 */
import { createPublicClient, http } from 'viem';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { httpUrlFor, loadConfig } from '../src/config.ts';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

async function rpc(url: string, method: string, params: unknown[], attempt = 0): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }))) as { result?: unknown; error?: { message?: string } };
  const limited = response.status === 429 || /too many requests/i.test(body.error?.message ?? '');
  if (limited && attempt < 5) {
    await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    return rpc(url, method, params, attempt + 1);
  }
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result;
}

async function solanaTraders(url: string): Promise<Array<[string, number]>> {
  const signatures = (await rpc(url, 'getSignaturesForAddress', [PUMP_PROGRAM, { limit: 1000 }])) as Array<{ signature: string; err: unknown }>;
  const counts = new Map<string, number>();
  for (const sig of signatures.filter((s) => s.err === null).slice(0, 30)) {
    const tx = (await rpc(url, 'getTransaction', [sig.signature, { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed', commitment: 'confirmed' }])) as
      { transaction?: { message?: { accountKeys?: Array<{ pubkey: string; signer: boolean }> } } } | null;
    const payer = tx?.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey;
    if (payer) counts.set(payer, (counts.get(payer) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

/** Well-known swap routers; a wallet that calls them is trading. */
const ROUTERS: Readonly<Record<string, readonly string[]>> = {
  bsc: ['0x10ed43c718714eb63d5aa57b78b54704e256024e'], // PancakeSwap V2 Router
  base: ['0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', '0x6ff5693b99212da76ad316178a184ab56d299b43'], // Uniswap V2 Router02, Universal Router
};

async function evmTraders(chain: EvmChainConfig, blocks: bigint): Promise<Array<[string, number]>> {
  const client = createPublicClient({ transport: http(httpUrlFor(chain)) });
  const routers = new Set(ROUTERS[chain.id] ?? []);
  const latest = await client.getBlockNumber();
  const counts = new Map<string, number>();
  for (let n = latest - blocks; n <= latest; n += 1n) {
    const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (!tx.to || !routers.has(tx.to.toLowerCase())) continue;
      counts.set(tx.from.toLowerCase(), (counts.get(tx.from.toLowerCase()) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

async function main(): Promise<void> {
  const config = loadConfig();
  process.stdout.write('Solana (Pump.fun fee payers, last ~60 txs):\n');
  for (const [address, n] of await solanaTraders(config.solanaRpcUrl)) process.stdout.write(`  ${address}  txs=${n}\n`);
  for (const [id, blocks] of [['bsc', 200n], ['base', 150n]] as const) {
    process.stdout.write(`${id} (senders of router swaps, last ${blocks} blocks):\n`);
    for (const [address, n] of await evmTraders(findEvmChain(id) as EvmChainConfig, blocks)) process.stdout.write(`  ${address}  swaps=${n}\n`);
  }
}

await main();

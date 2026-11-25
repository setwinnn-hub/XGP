import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { findEvmChain } from '../chains/evm/chains.ts';
import { httpUrlFor } from '../config.ts';
import type { ChainId } from '../core/types.ts';
import type { OnchainSupply } from './market-cap.ts';

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BURN_ADDRESSES: readonly Address[] = ['0x000000000000000000000000000000000000dEaD', '0x0000000000000000000000000000000000000000'];
const TIMEOUT_MS = 10_000;
const ERC20 = [
  parseAbiItem('function totalSupply() view returns (uint256)'),
  parseAbiItem('function decimals() view returns (uint8)'),
  parseAbiItem('function balanceOf(address) view returns (uint256)'),
] as const;

function units(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** totalSupply, decimals and burned balance of an ERC-20, read in one multicall. */
async function evmSupply(chain: ChainId, token: string, now: number): Promise<OnchainSupply | null> {
  const config = findEvmChain(chain);
  if (!config) return null;
  const client = createPublicClient({ transport: http(httpUrlFor(config), { timeout: TIMEOUT_MS }) });
  const address = token as Address;
  const results = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address, abi: ERC20, functionName: 'totalSupply' },
      { address, abi: ERC20, functionName: 'decimals' },
      { address, abi: ERC20, functionName: 'balanceOf', args: [BURN_ADDRESSES[0] as Address] },
      { address, abi: ERC20, functionName: 'balanceOf', args: [BURN_ADDRESSES[1] as Address] },
    ],
  });
  const [total, decimals, burnDead, burnZero] = results;
  const burns = [burnDead, burnZero];
  if (total?.status !== 'success' || decimals?.status !== 'success') return null;
  const d = Number(decimals.result);
  const burned = burns.reduce((sum, b) => sum + (b?.status === 'success' ? units(b.result as bigint, d) : 0), 0);
  return { totalSupply: units(total.result as bigint, d), decimals: d, burned, source: `${chain}-rpc:totalSupply`, at: now };
}

/** SPL token supply via getTokenSupply (burns reduce supply directly on Solana). */
async function solanaSupply(rpcUrl: string, mint: string, now: number, fetchFn: typeof fetch): Promise<OnchainSupply | null> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as { result?: { value?: { amount?: string; decimals?: number } }; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
  const value = body.result?.value;
  if (!value?.amount || typeof value.decimals !== 'number') return null;
  return { totalSupply: units(BigInt(value.amount), value.decimals), decimals: value.decimals, burned: 0, source: 'solana-rpc:getTokenSupply', at: now };
}

/** Token supply straight from the chain; null when it cannot be read. */
export async function fetchOnchainSupply(
  chain: ChainId, token: string, solanaRpcUrl: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now,
): Promise<OnchainSupply | null> {
  if (chain === 'solana') return solanaSupply(solanaRpcUrl, token, now(), fetchFn);
  if (chain === 'offchain') return null;
  return evmSupply(chain, token, now());
}

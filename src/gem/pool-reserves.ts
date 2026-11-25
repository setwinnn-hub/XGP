import { parseAbi, type Address, type PublicClient } from 'viem';

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);

/** On-chain reserves of a V2-style pair in human units, oriented to the watched token. */
export interface PairReserves {
  readonly pair: string;
  readonly tokenReserve: number;
  readonly quoteReserve: number;
  readonly quoteToken: string;
}

export interface PairRequest {
  readonly pair: string;
  readonly token: string;
}

const decimalsCache = new Map<string, number>();

/**
 * Reads getReserves/token0/token1 for many pairs in one multicall. Pairs that are not
 * V2-style (V3 pools revert on getReserves) are simply absent from the result.
 */
export async function fetchPairReserves(client: PublicClient, requests: readonly PairRequest[]): Promise<ReadonlyMap<string, PairReserves>> {
  if (requests.length === 0) return new Map();
  const calls = requests.flatMap((r) => (['getReserves', 'token0', 'token1'] as const).map((fn) => ({ address: r.pair as Address, abi: PAIR_ABI, functionName: fn })));
  const results = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: calls });
  const raw = requests.flatMap((r, i) => {
    const [reserves, t0, t1] = [results[i * 3], results[i * 3 + 1], results[i * 3 + 2]];
    if (reserves?.status !== 'success' || t0?.status !== 'success' || t1?.status !== 'success') return [];
    const [r0, r1] = reserves.result as readonly [bigint, bigint, number];
    const token0 = String(t0.result).toLowerCase();
    const token1 = String(t1.result).toLowerCase();
    const mine = r.token.toLowerCase();
    if (mine !== token0 && mine !== token1) return [];
    return [{ request: r, token0, token1, r0, r1 }];
  });
  const missing = [...new Set(raw.flatMap((x) => [x.token0, x.token1]))].filter((t) => !decimalsCache.has(t));
  if (missing.length > 0) {
    const dec = await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: true,
      contracts: missing.map((t) => ({ address: t as Address, abi: ERC20_ABI, functionName: 'decimals' as const })),
    });
    missing.forEach((t, i) => { const d = dec[i]; if (d?.status === 'success') decimalsCache.set(t, Number(d.result)); });
  }
  const out = new Map<string, PairReserves>();
  for (const x of raw) {
    const d0 = decimalsCache.get(x.token0);
    const d1 = decimalsCache.get(x.token1);
    if (d0 === undefined || d1 === undefined) continue;
    const amount0 = Number(x.r0) / 10 ** d0;
    const amount1 = Number(x.r1) / 10 ** d1;
    const tokenIs0 = x.request.token.toLowerCase() === x.token0;
    out.set(x.request.pair.toLowerCase(), {
      pair: x.request.pair.toLowerCase(),
      tokenReserve: tokenIs0 ? amount0 : amount1,
      quoteReserve: tokenIs0 ? amount1 : amount0,
      quoteToken: tokenIs0 ? x.token1 : x.token0,
    });
  }
  return out;
}

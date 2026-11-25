import type { DetailValue, RadarEvent } from '../../core/types.ts';
import type { DexFactory, EvmChainConfig } from './chains.ts';

export interface PairLogInput {
  readonly chain: EvmChainConfig;
  readonly factory: DexFactory;
  /** Decoded event arguments from viem. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly detectedAt: number;
}

export interface TokenMeta {
  readonly name: string | null;
  readonly symbol: string | null;
}

export interface PairSides {
  readonly token: string;
  /** Symbol of the known quote token, or null when neither side is a known quote. */
  readonly quoteSymbol: string | null;
  readonly quoteAddress: string | null;
  readonly pairId: string | null;
}

function addressArg(args: PairLogInput['args'], key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

/** Extracts both sides of a new pair and decides which one is the new token. */
export function pairSides(input: PairLogInput): PairSides | null {
  const isV4 = input.factory.kind === 'uniswap-v4';
  const a = addressArg(input.args, isV4 ? 'currency0' : 'token0');
  const b = addressArg(input.args, isV4 ? 'currency1' : 'token1');
  if (!a || !b) return null;
  const quoteA = input.chain.quoteTokens[a.toLowerCase()];
  const quoteB = input.chain.quoteTokens[b.toLowerCase()];
  if (quoteA && quoteB) return null;

  const rawPair = isV4 ? input.args.id : input.args.pair ?? input.args.pool;
  const pairId = typeof rawPair === 'string' ? rawPair : null;
  if (quoteA) return { token: b, quoteSymbol: quoteA, quoteAddress: a, pairId };
  if (quoteB) return { token: a, quoteSymbol: quoteB, quoteAddress: b, pairId };
  return { token: a, quoteSymbol: null, quoteAddress: null, pairId };
}

function extraDetails(input: PairLogInput): Record<string, DetailValue> {
  const { args } = input;
  const fee = typeof args.fee === 'number' ? args.fee : null;
  const hooks = addressArg(args, 'hooks');
  const stable = typeof args.stable === 'boolean' ? args.stable : null;
  return {
    feeBps: fee === null ? null : fee / 100,
    hooks: hooks && /^0x0{40}$/i.test(hooks) ? null : hooks,
    stable,
  };
}

/**
 * Builds the normalized event for a new EVM pair/pool. Returns null for pairs between two
 * known quote tokens (e.g. WETH/USDC), which are never new meme tokens.
 */
export function normalizePairLog(input: PairLogInput, meta: TokenMeta): RadarEvent | null {
  const sides = pairSides(input);
  if (!sides) return null;
  const { chain, factory } = input;
  const pairLink = sides.pairId ?? sides.token;
  return {
    key: `${chain.id}:${input.txHash}:${input.logIndex}`,
    kind: 'pair_created',
    chain: chain.id,
    source: `${chain.id}:${factory.name}`,
    tokenAddress: sides.token,
    tokenName: meta.name,
    tokenSymbol: meta.symbol,
    txHash: input.txHash,
    detectedAt: input.detectedAt,
    details: {
      platform: factory.name,
      quoteSymbol: sides.quoteSymbol,
      quoteAddress: sides.quoteAddress,
      pairId: sides.pairId,
      blockNumber: Number(input.blockNumber),
      ...extraDetails(input),
    },
    links: [
      { label: 'DexScreener', url: `https://dexscreener.com/${chain.dexscreenerSlug}/${pairLink}` },
      { label: 'Explorer TX', url: `${chain.explorerTxUrl}${input.txHash}` },
      { label: 'Token', url: `${chain.explorerTokenUrl}${sides.token}` },
    ],
  };
}

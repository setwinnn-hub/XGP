import type { Address } from 'viem';

export type EvmChainId = 'ethereum' | 'base' | 'bsc' | 'arbitrum' | 'polygon' | 'optimism' | 'avalanche';

export type DexKind = 'uniswap-v2' | 'uniswap-v3' | 'uniswap-v4' | 'aerodrome' | 'aerodrome-cl';

export interface DexFactory {
  readonly name: string;
  readonly kind: DexKind;
  readonly address: Address;
}

export interface EvmChainConfig {
  readonly id: EvmChainId;
  readonly label: string;
  readonly chainId: number;
  /** Default public endpoints. Override with EVM_<ID>_WS_URL / EVM_<ID>_HTTP_URL. */
  readonly defaultWsUrl: string;
  readonly defaultHttpUrl: string;
  readonly explorerTxUrl: string;
  readonly explorerTokenUrl: string;
  readonly dexscreenerSlug: string;
  /** Lower-cased address -> symbol. The "other" side of a new pair is the new token. */
  readonly quoteTokens: Readonly<Record<string, string>>;
  readonly factories: readonly DexFactory[];
  /** No new block for this long means the connection is considered stalled. */
  readonly staleBlockMs: number;
}

const NATIVE = '0x0000000000000000000000000000000000000000';

const ETHEREUM: EvmChainConfig = {
  id: 'ethereum',
  label: 'Ethereum',
  chainId: 1,
  defaultWsUrl: 'wss://ethereum-rpc.publicnode.com',
  defaultHttpUrl: 'https://ethereum-rpc.publicnode.com',
  explorerTxUrl: 'https://etherscan.io/tx/',
  explorerTokenUrl: 'https://etherscan.io/token/',
  dexscreenerSlug: 'ethereum',
  quoteTokens: {
    [NATIVE]: 'ETH',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  },
  factories: [
    { name: 'Uniswap V2', kind: 'uniswap-v2', address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' },
    { name: 'Uniswap V3', kind: 'uniswap-v3', address: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
    { name: 'Uniswap V4', kind: 'uniswap-v4', address: '0x000000000004444c5dc75cB358380D2e3dE08A90' },
  ],
  staleBlockMs: 60_000,
};

const BASE: EvmChainConfig = {
  id: 'base',
  label: 'Base',
  chainId: 8453,
  defaultWsUrl: 'wss://base-rpc.publicnode.com',
  defaultHttpUrl: 'https://base-rpc.publicnode.com',
  explorerTxUrl: 'https://basescan.org/tx/',
  explorerTokenUrl: 'https://basescan.org/token/',
  dexscreenerSlug: 'base',
  quoteTokens: {
    [NATIVE]: 'ETH',
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  },
  factories: [
    { name: 'Uniswap V2', kind: 'uniswap-v2', address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' },
    { name: 'Uniswap V3', kind: 'uniswap-v3', address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' },
    { name: 'Uniswap V4', kind: 'uniswap-v4', address: '0x498581fF718922c3f8e6A244956aF099B2652b2b' },
    { name: 'Aerodrome', kind: 'aerodrome', address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
    { name: 'Aerodrome CL', kind: 'aerodrome-cl', address: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' },
    { name: 'PancakeSwap V3', kind: 'uniswap-v3', address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' },
  ],
  staleBlockMs: 30_000,
};

const BSC: EvmChainConfig = {
  id: 'bsc',
  label: 'BNB Chain',
  chainId: 56,
  defaultWsUrl: 'wss://bsc-rpc.publicnode.com',
  defaultHttpUrl: 'https://bsc-rpc.publicnode.com',
  explorerTxUrl: 'https://bscscan.com/tx/',
  explorerTokenUrl: 'https://bscscan.com/token/',
  dexscreenerSlug: 'bsc',
  quoteTokens: {
    [NATIVE]: 'BNB',
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
    '0x55d398326f99059ff775485246999027b3197955': 'USDT',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD',
  },
  factories: [
    { name: 'PancakeSwap V2', kind: 'uniswap-v2', address: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' },
    { name: 'PancakeSwap V3', kind: 'uniswap-v3', address: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' },
    { name: 'Uniswap V2', kind: 'uniswap-v2', address: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' },
    { name: 'Uniswap V3', kind: 'uniswap-v3', address: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7' },
    { name: 'Uniswap V4', kind: 'uniswap-v4', address: '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF' },
  ],
  staleBlockMs: 30_000,
};

/**
 * Chains enabled in Phase 1. Arbitrum, Polygon, Optimism and Avalanche are added here
 * as config only once their factory addresses pass `npm run verify:evm`.
 */
export const EVM_CHAINS: readonly EvmChainConfig[] = [ETHEREUM, BASE, BSC];

export function findEvmChain(id: string): EvmChainConfig | undefined {
  return EVM_CHAINS.find((chain) => chain.id === id);
}

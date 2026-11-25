import { parseAbiItem } from 'viem';

/** Uniswap V2 style factories (Uniswap V2, PancakeSwap V2 and forks). */
export const PAIR_CREATED_V2 = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
);

/** Uniswap V3 style factories (Uniswap V3, PancakeSwap V3). */
export const POOL_CREATED_V3 = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
);

/** Uniswap V4 singleton PoolManager. Pools have an id, not an address. */
export const INITIALIZE_V4 = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

/** Aerodrome (Base) classic pool factory. */
export const POOL_CREATED_AERODROME = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)',
);

/** Aerodrome Slipstream (concentrated liquidity) factory. */
export const POOL_CREATED_AERODROME_CL = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)',
);

export const ERC20_METADATA_ABI = [
  parseAbiItem('function name() view returns (string)'),
  parseAbiItem('function symbol() view returns (string)'),
  parseAbiItem('function decimals() view returns (uint8)'),
] as const;

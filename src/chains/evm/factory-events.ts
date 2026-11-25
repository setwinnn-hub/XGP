import type { AbiEvent } from 'viem';
import {
  INITIALIZE_V4,
  PAIR_CREATED_V2,
  POOL_CREATED_AERODROME,
  POOL_CREATED_AERODROME_CL,
  POOL_CREATED_V3,
} from './abis.ts';
import type { DexKind } from './chains.ts';

/** The factory event each DEX kind emits when a new pair/pool is created. */
export function factoryEventFor(kind: DexKind): AbiEvent {
  switch (kind) {
    case 'uniswap-v2':
      return PAIR_CREATED_V2;
    case 'uniswap-v3':
      return POOL_CREATED_V3;
    case 'uniswap-v4':
      return INITIALIZE_V4;
    case 'aerodrome':
      return POOL_CREATED_AERODROME;
    case 'aerodrome-cl':
      return POOL_CREATED_AERODROME_CL;
  }
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { normalizePairLog, pairSides, type PairLogInput } from '../src/chains/evm/normalize.ts';

const BASE = findEvmChain('base') as EvmChainConfig;
const WETH = '0x4200000000000000000000000000000000000006';
const NEW_TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const V2 = BASE.factories.find((f) => f.kind === 'uniswap-v2');
const V4 = BASE.factories.find((f) => f.kind === 'uniswap-v4');

function input(overrides: Partial<PairLogInput>): PairLogInput {
  if (!V2) throw new Error('missing V2 factory');
  return {
    chain: BASE, factory: V2, args: {}, txHash: '0xabc', logIndex: 7, blockNumber: 123n, detectedAt: 5000, ...overrides,
  };
}

describe('pairSides', () => {
  it('picks the non-quote side as the new token', () => {
    const sides = pairSides(input({ args: { token0: WETH, token1: NEW_TOKEN, pair: OTHER } }));
    assert.deepEqual(sides, { token: NEW_TOKEN, quoteSymbol: 'WETH', quoteAddress: WETH, pairId: OTHER });
  });

  it('reads Uniswap V4 currency fields and the native-ETH quote', () => {
    const poolId = `0x${'ab'.repeat(32)}`;
    const sides = pairSides(input({ factory: V4, args: { id: poolId, currency0: '0x0000000000000000000000000000000000000000', currency1: NEW_TOKEN } }));
    assert.equal(sides?.token, NEW_TOKEN);
    assert.equal(sides?.quoteSymbol, 'ETH');
    assert.equal(sides?.pairId, poolId);
  });

  it('returns null for pairs of two quote tokens', () => {
    assert.equal(pairSides(input({ args: { token0: WETH, token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } })), null);
  });

  it('returns null when an address is missing or malformed', () => {
    assert.equal(pairSides(input({ args: { token0: 'nope', token1: NEW_TOKEN } })), null);
  });

  it('marks pairs without a known quote token', () => {
    assert.equal(pairSides(input({ args: { token0: NEW_TOKEN, token1: OTHER } }))?.quoteSymbol, null);
  });
});

describe('normalizePairLog', () => {
  it('builds a pair_created event with explorer and DexScreener links', () => {
    const event = normalizePairLog(input({ args: { token0: NEW_TOKEN, token1: WETH, pair: OTHER } }), { name: 'Test', symbol: 'TST' });
    assert.ok(event);
    assert.equal(event.key, 'base:0xabc:7');
    assert.equal(event.source, 'base:Uniswap V2');
    assert.equal(event.tokenAddress, NEW_TOKEN);
    assert.equal(event.tokenSymbol, 'TST');
    assert.equal(event.details.blockNumber, 123);
    assert.ok(event.links.some((l) => l.url === `https://dexscreener.com/base/${OTHER}`));
    assert.ok(event.links.some((l) => l.url === 'https://basescan.org/tx/0xabc'));
  });

  it('records fee in basis points and drops the zero hooks address', () => {
    const event = normalizePairLog(
      input({ factory: V4, args: { id: '0x01', currency0: WETH, currency1: NEW_TOKEN, fee: 3000, hooks: `0x${'0'.repeat(40)}` } }),
      { name: null, symbol: null },
    );
    assert.equal(event?.details.feeBps, 30);
    assert.equal(event?.details.hooks, null);
  });
});

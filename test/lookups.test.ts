import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchSolanaBlockTime } from '../src/chains/solana/chain-time.ts';
import { fetchDexScreenerTokenName } from '../src/enrich/dexscreener.ts';
import { fetchStub, jsonResponse } from './helpers.ts';

describe('fetchSolanaBlockTime', () => {
  it('returns blockTime from getTransaction', async () => {
    const stub = fetchStub([() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { blockTime: 1_795_559_030 } })]);
    assert.equal(await fetchSolanaBlockTime('https://rpc', 'sig', stub.fn), 1_795_559_030);
    assert.equal(JSON.parse(stub.calls[0]?.body ?? '{}').method, 'getTransaction');
  });

  it('returns null when the transaction is not found yet', async () => {
    const stub = fetchStub([() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null })]);
    assert.equal(await fetchSolanaBlockTime('https://rpc', 'sig', stub.fn), null);
  });

  it('throws on RPC and HTTP errors', async () => {
    await assert.rejects(fetchSolanaBlockTime('https://rpc', 'sig', fetchStub([() => jsonResponse({ error: { message: 'rate limited' } })]).fn), /rate limited/);
    await assert.rejects(fetchSolanaBlockTime('https://rpc', 'sig', fetchStub([() => jsonResponse({}, 503)]).fn), /HTTP 503/);
  });
});

describe('fetchDexScreenerTokenName', () => {
  it('returns the base token name matching the address (case-insensitive)', async () => {
    const stub = fetchStub([() => jsonResponse([
      { baseToken: { address: 'OTHER', name: 'No', symbol: 'NO' } },
      { baseToken: { address: 'mintabc', name: 'Yes', symbol: 'YES' } },
    ])]);
    assert.deepEqual(await fetchDexScreenerTokenName('solana', 'MintABC', stub.fn), { name: 'Yes', symbol: 'YES' });
    assert.equal(stub.calls[0]?.url, 'https://api.dexscreener.com/tokens/v1/solana/MintABC');
  });

  it('returns null for unknown tokens and throws on HTTP errors', async () => {
    assert.equal(await fetchDexScreenerTokenName('solana', 'x', fetchStub([() => jsonResponse([])]).fn), null);
    await assert.rejects(fetchDexScreenerTokenName('solana', 'x', fetchStub([() => jsonResponse({}, 429)]).fn), /429/);
  });
});

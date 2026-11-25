import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { httpUrlFor, loadConfig, wsUrlFor } from '../src/config.ts';
import { WEBHOOK_URL } from './helpers.ts';

describe('loadConfig', () => {
  it('uses safe defaults with no environment', () => {
    const config = loadConfig({});
    assert.equal(config.pumpfun.newTokenMode, 'filtered');
    assert.equal(config.pumpfun.minDevBuySol, 2);
    assert.deepEqual(config.evmChains.map((c) => c.id), ['ethereum', 'base', 'bsc']);
    assert.deepEqual(config.webhooks, {});
  });

  it('reads valid webhooks per category', () => {
    const config = loadConfig({ DISCORD_WEBHOOK_NEW_TOKEN: WEBHOOK_URL });
    assert.equal(config.webhooks.NEW_TOKEN, WEBHOOK_URL);
  });

  it('rejects non-Discord webhook URLs', () => {
    assert.throws(() => loadConfig({ DISCORD_WEBHOOK_NEW_TOKEN: 'https://evil.example/api/webhooks/1/x' }), /not a Discord webhook/);
  });

  it('rejects invalid numbers, booleans, enums and chains', () => {
    assert.throws(() => loadConfig({ PUMPFUN_MIN_DEV_BUY_SOL: 'abc' }));
    assert.throws(() => loadConfig({ LATENCY_SAMPLE_RATE: '2' }));
    assert.throws(() => loadConfig({ PUMPFUN_MIGRATION_ALERTS: 'maybe' }));
    assert.throws(() => loadConfig({ PUMPFUN_NEW_TOKEN_ALERTS: 'some' }));
    assert.throws(() => loadConfig({ EVM_CHAINS: 'base,dogechain' }), /unknown chain/);
  });

  it('parses keyword lists and chain subsets', () => {
    const config = loadConfig({ PUMPFUN_KEYWORDS: ' Pepe, ,DOGE ', EVM_CHAINS: 'base' });
    assert.deepEqual(config.pumpfun.keywords, ['pepe', 'doge']);
    assert.deepEqual(config.evmChains.map((c) => c.id), ['base']);
  });
});

describe('RPC URL overrides', () => {
  const base = findEvmChain('base') as EvmChainConfig;

  it('falls back to public endpoints', () => {
    assert.equal(wsUrlFor(base, {}), base.defaultWsUrl);
    assert.equal(httpUrlFor(base, {}), base.defaultHttpUrl);
  });

  it('uses per-chain overrides', () => {
    assert.equal(wsUrlFor(base, { EVM_BASE_WS_URL: 'wss://x' }), 'wss://x');
    assert.equal(httpUrlFor(base, { EVM_BASE_HTTP_URL: 'https://x' }), 'https://x');
  });
});

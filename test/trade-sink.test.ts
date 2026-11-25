import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceBook } from '../src/enrich/prices.ts';
import type { WalletTrade } from '../src/trades/trade-event.ts';
import { createTradeSink } from '../src/trades/trade-sink.ts';

const prices: PriceBook = { usdValue: (symbol, amount) => (symbol === 'SOL' ? amount * 200 : null), fxRate: () => null, start: () => undefined, stop: () => undefined };
const wallet = { chain: 'solana' as const, address: 'W1', label: 'Alpha', addedAt: 0 };
const trade = { side: 'BUY' as const, token: 'MintX', tokenAmount: 100, quoteSymbol: 'SOL', quoteAmount: 0.5, quoteIsStable: false };

describe('trade sink', () => {
  it('adds the looked-up name and the USD value', async () => {
    const emitted: WalletTrade[] = [];
    const sink = createTradeSink({ prices, nameLookup: async () => ({ name: 'Dog', symbol: 'DOG' }), emit: (t) => { emitted.push(t); } });
    await sink(trade, { chain: 'solana', wallet, txHash: 's', detectedAt: 1, decoder: 'pumpportal', venue: 'Pump.fun' });
    assert.equal(emitted[0]?.tokenSymbol, 'DOG');
    assert.equal(emitted[0]?.usdValue, 100);
    assert.equal(emitted[0]?.walletLabel, 'Alpha');
  });

  it('does not hold the alert for a slow name lookup', async () => {
    const emitted: WalletTrade[] = [];
    const slow = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000));
    const sink = createTradeSink({ prices, nameLookup: slow, emit: (t) => { emitted.push(t); } });
    const started = Date.now();
    await sink(trade, { chain: 'solana', wallet, txHash: 's', detectedAt: 1, decoder: 'pumpportal', venue: null });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(emitted[0]?.tokenName, null);
  });

  it('keeps names the decoder already knows', async () => {
    const emitted: WalletTrade[] = [];
    let lookups = 0;
    const sink = createTradeSink({ prices, nameLookup: async () => { lookups += 1; return null; }, emit: (t) => { emitted.push(t); } });
    await sink(trade, { chain: 'base', wallet: { ...wallet, chain: 'base' }, txHash: 's', detectedAt: 1, decoder: 'evm-block', venue: null, tokenSymbol: 'TKN', tokenName: 'Token' });
    assert.equal(lookups, 0);
    assert.equal(emitted[0]?.tokenSymbol, 'TKN');
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { findEvmChain, type EvmChainConfig } from '../src/chains/evm/chains.ts';
import { evmBalanceDeltas, transferDeltas } from '../src/chains/evm/wallet-scanner.ts';
import { classifySolanaTx, solanaBalanceDeltas, type ParsedSolanaTx } from '../src/chains/solana/solana-trade.ts';
import { classifySwap } from '../src/trades/classify.ts';
import { explorerUrls, toTradeEvent, tradeKey, type WalletTrade } from '../src/trades/trade-event.ts';

interface Fixture {
  readonly wallet: string;
  readonly signature: string;
  readonly expected: { readonly side: string; readonly token: string; readonly tokenAmount: number; readonly quoteAmount: number };
  readonly tx: ParsedSolanaTx;
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;
}

describe('classifySwap', () => {
  const sol = (amount: number) => ({ symbol: 'SOL', amount, stable: false });

  it('detects a buy and a sell', () => {
    assert.deepEqual(classifySwap([sol(-1.5)], [{ token: 'T', amount: 1000 }]), {
      ok: true, trade: { side: 'BUY', token: 'T', tokenAmount: 1000, quoteSymbol: 'SOL', quoteAmount: 1.5, quoteIsStable: false },
    });
    const sell = classifySwap([sol(2)], [{ token: 'T', amount: -500 }]);
    assert.equal(sell.ok && sell.trade.side, 'SELL');
  });

  it('prefers the stablecoin leg as the price when both move', () => {
    const result = classifySwap([sol(-0.001), { symbol: 'USDC', amount: -250, stable: true }], [{ token: 'T', amount: 10 }]);
    assert.equal(result.ok && result.trade.quoteSymbol, 'USDC');
    assert.equal(result.ok && result.trade.quoteAmount, 250);
  });

  it('rejects transfers, airdrops and token-to-token swaps', () => {
    assert.equal(classifySwap([sol(0)], [{ token: 'T', amount: 10 }]).ok, false);
    assert.equal(classifySwap([sol(-1)], [{ token: 'T', amount: -10 }]).ok, false);
    assert.equal(classifySwap([sol(-1)], [{ token: 'A', amount: 10 }, { token: 'B', amount: -5 }]).ok, false);
    assert.equal(classifySwap([sol(-1)], []).ok, false);
  });
});

describe('Solana balance-delta decoding (real mainnet transactions)', () => {
  for (const name of ['solana-buy.json', 'solana-sell.json']) {
    it(`decodes ${name}`, () => {
      const { wallet, tx, expected } = fixture(name);
      const result = classifySolanaTx(tx, wallet);
      assert.ok(result.ok, result.ok ? '' : result.reason);
      assert.equal(result.trade.side, expected.side);
      assert.equal(result.trade.token, expected.token);
      assert.equal(result.trade.tokenAmount, expected.tokenAmount);
      assert.equal(result.trade.quoteAmount, expected.quoteAmount);
    });
  }

  it('ignores the transaction for a wallet that is not in it', () => {
    const { tx } = fixture('solana-buy.json');
    assert.equal(solanaBalanceDeltas(tx, 'NotInThisTransaction1111111111111111111111'), null);
  });

  it('does not report opening/closing a token account (rent only) as a trade', () => {
    const { wallet, tx } = fixture('solana-sell.json');
    const meta = tx.meta;
    assert.ok(meta);
    const index = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === wallet);
    const pre = meta.preBalances[index] ?? 0;
    const fee = index === 0 ? meta.fee : 0;
    const postBalances = meta.postBalances.map((b, i) => (i === index ? pre + 2_039_280 - fee : b));
    const rentOnly = { ...tx, meta: { ...meta, postBalances, preTokenBalances: meta.preTokenBalances?.map((b) => ({ ...b })) } };
    const result = classifySolanaTx(rentOnly, wallet);
    assert.equal(result.ok, false);
  });

  it('ignores failed transactions', () => {
    const { wallet, tx } = fixture('solana-buy.json');
    const failed = { ...tx, meta: tx.meta ? { ...tx.meta, err: { InstructionError: [0, 'Custom'] } } : null };
    assert.equal(classifySolanaTx(failed, wallet).ok, false);
  });
});

describe('EVM balance-delta decoding', () => {
  const base = findEvmChain('base') as EvmChainConfig;
  const wallet = '0x1111111111111111111111111111111111111111';
  const pad = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const TOKEN = '0x2222222222222222222222222222222222222222';
  const POOL = '0x3333333333333333333333333333333333333333';
  const WETH = '0x4200000000000000000000000000000000000006';
  const value = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

  it('nets Transfer logs per token for the wallet', () => {
    const logs = [
      { address: TOKEN, topics: [TRANSFER, pad(POOL), pad(wallet)], data: value(1000n) },
      { address: TOKEN, topics: [TRANSFER, pad(wallet), pad(POOL)], data: value(300n) },
      { address: TOKEN, topics: [TRANSFER, pad(POOL), pad(POOL)], data: value(5n) },
    ];
    assert.deepEqual([...transferDeltas(logs, wallet)], [[TOKEN, 700n]]);
  });

  it('treats WETH as ETH and finds a sell paid out in native ETH', () => {
    const raw = new Map([[TOKEN, -(10n ** 21n)], [WETH, 0n]]);
    const info = new Map([[TOKEN, { decimals: 18, symbol: 'TKN', name: 'Token' }]]);
    const deltas = evmBalanceDeltas(base, 5n * 10n ** 17n, raw, info);
    const result = classifySwap(deltas.quotes, deltas.tokens);
    assert.ok(result.ok);
    assert.deepEqual(result.trade, { side: 'SELL', token: TOKEN, tokenAmount: 1000, quoteSymbol: 'ETH', quoteAmount: 0.5, quoteIsStable: false });
  });

  it('reads stablecoin legs with their decimals', () => {
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const raw = new Map([[TOKEN, 5n * 10n ** 18n], [usdc, -250_000_000n]]);
    const info = new Map([[TOKEN, { decimals: 18, symbol: 'TKN', name: null }], [usdc, { decimals: 6, symbol: 'USDC', name: null }]]);
    const result = classifySwap(...Object.values(evmBalanceDeltas(base, 0n, raw, info)) as [never, never]);
    assert.ok(result.ok);
    assert.equal(result.trade.quoteSymbol, 'USDC');
    assert.equal(result.trade.quoteAmount, 250);
  });
});

describe('trade events', () => {
  const trade: WalletTrade = {
    chain: 'base', wallet: '0xabc', walletLabel: 'Alpha', side: 'BUY', token: '0xdef', tokenName: 'Dog', tokenSymbol: 'DOG',
    tokenAmount: 10, quoteSymbol: 'ETH', quoteAmount: 0.1, usdValue: 300, txHash: '0x99', detectedAt: 1000, decoder: 'evm-block', venue: null,
  };

  it('uses one key per tx and wallet, so two decoders cannot alert twice', () => {
    assert.equal(toTradeEvent(trade, explorerUrls('base', 'https://basescan.org/tx/')).key, tradeKey('base', '0x99', '0xabc'));
  });

  it('links explorer address and tx pages', () => {
    const urls = explorerUrls('base', 'https://basescan.org/tx/');
    assert.equal(urls.address, 'https://basescan.org/address/');
    const event = toTradeEvent(trade, urls);
    assert.ok(event.links.some((l) => l.url === 'https://basescan.org/address/0xabc'));
    assert.equal(explorerUrls('solana', null).tx, 'https://solscan.io/tx/');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePumpPortalMessage } from '../src/chains/solana/pumpportal-parse.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { createPriceBook } from '../src/enrich/prices.ts';
import { decideAlert } from '../src/notify/filters.ts';
import { buildTradeAlert } from '../src/notify/format-trade.ts';
import { createNotifier } from '../src/notify/notifier.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { explorerUrls, toTradeEvent, type WalletTrade } from '../src/trades/trade-event.ts';
import { fetchStub, jsonResponse, testConfig, WEBHOOK_URL } from './helpers.ts';

const OTHER_WEBHOOK = 'https://discord.com/api/webhooks/999999999999999999/other-token';

function trade(overrides: Partial<WalletTrade> = {}): RadarEvent {
  const base: WalletTrade = {
    chain: 'solana', wallet: 'Wallet111', walletLabel: 'Alpha Trader', side: 'BUY',
    token: 'Mint111', tokenName: 'Waddle Penguin', tokenSymbol: 'WADDLE', tokenAmount: 1_250_000,
    quoteSymbol: 'SOL', quoteAmount: 2.5, usdValue: 500, txHash: 'sig1', detectedAt: 10_000, decoder: 'pumpportal', venue: 'Pump.fun',
  };
  return toTradeEvent({ ...base, ...overrides }, explorerUrls('solana', null));
}

describe('PumpPortal account trades', () => {
  it('parses buy and sell messages', () => {
    const raw = {
      signature: '4dHbgR7kNeYy2JeRiVTMQH7M9E8LAmgCZGbJLbKCBpCBDKgxSp7XwJr9VYpW9U66NMB9QbYZtMNXjmByeNnudq7s',
      mint: 'Ch6GryQYtGUSqcNwRY6eqMgxbkSLb2pozaNjSw31pump', traderPublicKey: '99pdD9jqnyGRhBL88Aw7bcuxQYVvawuo6brbe5o6ssXG',
      txType: 'buy', tokenAmount: 1000, solAmount: 0.5, marketCapSol: 40, pool: 'pump',
    };
    const buy = parsePumpPortalMessage(JSON.stringify(raw), 0);
    assert.equal(buy.type === 'trade' && buy.trade.side, 'BUY');
    const sell = parsePumpPortalMessage(JSON.stringify({ ...raw, txType: 'sell' }), 0);
    assert.equal(sell.type === 'trade' && sell.trade.side, 'SELL');
    assert.equal(parsePumpPortalMessage(JSON.stringify({ ...raw, solAmount: undefined }), 0).type, 'ignored');
  });
});

describe('trade filters and format', () => {
  it('routes buys and sells to their categories and honors MIN_TRADE_USD', () => {
    assert.deepEqual(decideAlert(trade(), testConfig()), { alert: true, category: 'SMART_MONEY_BUY', reason: 'followed wallet trade' });
    assert.equal(decideAlert(trade({ side: 'SELL' }), testConfig()).alert && 'SELL', 'SELL');
    assert.equal(decideAlert(trade({ usdValue: 5 }), testConfig({ MIN_TRADE_USD: '10' })).alert, false);
    assert.equal(decideAlert(trade({ usdValue: null }), testConfig({ MIN_TRADE_USD: '10' })).alert, true);
  });

  it('shows who traded what, value, repeat count and whale badge', () => {
    const embed = buildTradeAlert(trade(), { isWhale: true, priorSameSide: 2 }).embeds[0];
    assert.equal(embed?.title, '🐋 🟢 BUY  $WADDLE · Waddle Penguin');
    assert.ok(embed?.description?.includes('Alpha Trader'));
    const text = JSON.stringify(embed?.fields);
    assert.ok(text.includes('$500'));
    assert.ok(text.includes('2.5 SOL'));
    assert.ok(text.includes('1.25M WADDLE'));
    assert.ok(text.includes('ครั้งที่ 3'));
  });

  it('says when no USD price is known instead of guessing', () => {
    const text = JSON.stringify(buildTradeAlert(trade({ usdValue: null }), { isWhale: false, priorSameSide: 0 }).embeds[0]?.fields);
    assert.ok(text.includes('ไม่มีราคา USD'));
    assert.ok(text.includes('ซื้อครั้งแรก'));
  });
});

describe('Notifier with trades', () => {
  it('uses DISCORD_WEBHOOK_DEFAULT and counts earlier buys', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const first = trade();
    const second = trade({ txHash: 'sig2', detectedAt: 20_000 });
    repo.insert(first);
    repo.insert(second);
    const stub = fetchStub([() => jsonResponse({ id: '175928847299117063' })]);
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_DEFAULT: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn: stub.fn });
    await notifier.handle(second);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0]?.body?.includes('ครั้งที่ 2'));
    assert.deepEqual(notifier.dryRunCategories(), []);
  });

  it('copies whale trades to a separate WHALE channel only', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const whale = trade({ usdValue: 50_000 });
    repo.insert(whale);
    const stub = fetchStub([() => jsonResponse({ id: '175928847299117063' })]);
    const config = testConfig({ DISCORD_WEBHOOK_DEFAULT: WEBHOOK_URL, DISCORD_WEBHOOK_WHALE: OTHER_WEBHOOK });
    await createNotifier({ config, repo, logger: silentLogger, fetchFn: stub.fn }).handle(whale);
    assert.deepEqual(stub.calls.map((c) => c.url.split('/')[5]), ['123456789012345678', '999999999999999999']);

    const sameChannel = fetchStub([() => jsonResponse({ id: '175928847299117063' })]);
    const repo2 = createEventRepository(openDatabase(':memory:'));
    repo2.insert(whale);
    await createNotifier({ config: testConfig({ DISCORD_WEBHOOK_DEFAULT: WEBHOOK_URL }), repo: repo2, logger: silentLogger, fetchFn: sameChannel.fn }).handle(whale);
    assert.equal(sameChannel.calls.length, 1);
  });
});

describe('PriceBook', () => {
  it('converts with fresh CoinGecko prices and treats stables as $1', async () => {
    const stub = fetchStub([() => jsonResponse({ solana: { usd: 200 }, ethereum: { usd: 3000 }, binancecoin: { usd: 600 } })]);
    let now = 0;
    const book = createPriceBook(silentLogger, stub.fn, () => now);
    book.start();
    book.stop();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(book.usdValue('SOL', 2), 400);
    assert.equal(book.usdValue('WETH', 1), 3000);
    assert.equal(book.usdValue('USDC', 12.5), 12.5);
    assert.equal(book.usdValue('DOGE', 1), null);
    now = 11 * 60_000;
    assert.equal(book.usdValue('SOL', 2), null);
  });
});

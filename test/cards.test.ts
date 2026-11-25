import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { silentLogger } from '../src/core/logger.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { analysisCard, clockTime, tokenCard, tradeCard } from '../src/notify/card-data.ts';
import { createCardRenderer } from '../src/notify/card-render.ts';
import { buildCardSvg, clip } from '../src/notify/card.ts';
import { requestBody } from '../src/notify/discord-client.ts';
import { createNotifier } from '../src/notify/notifier.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { makeEvent, testConfig, WEBHOOK_URL } from './helpers.ts';

const NOW = Date.parse('2026-11-25T18:13:00Z');

describe('card data', () => {
  it('new token card: badge, contract, dev buy, market cap and detection time', () => {
    const card = tokenCard(makeEvent({ detectedAt: NOW, details: { platform: 'Pump.fun', devBuySol: 2.47, marketCapSol: 32.8 } }));
    assert.ok(card.badge.startsWith('NEW TOKEN · SOLANA'));
    assert.equal(card.title, '$DOOROC');
    assert.deepEqual(card.stats.map((s) => s.value), ['2.47 SOL', '32.8 SOL', clockTime(NOW)]);
    assert.equal(card.side.big, 'NEW');
  });

  it('trade card: USD value is the big number, repeat count and red for sells', () => {
    const event = makeEvent({ kind: 'wallet_trade', chain: 'bsc', tokenSymbol: 'TRUMP', tokenName: 'Trump Meme', details: { side: 'SELL', wallet: '0xa6ee430f253057aa4de8d757f6de081bdaa75e52', walletLabel: 'Trader C', tokenAmount: 9738, quoteAmount: 1.8, quoteSymbol: 'BNB', usdValue: 993 } });
    const card = tradeCard(event, { priorSameSide: 64, isWhale: false });
    assert.equal(card.accent, 'red');
    assert.equal(card.side.big, '$993');
    assert.ok(card.stats.some((s) => s.value === '65'));
  });

  it('analysis card: score is the big number and holders are shown when known', () => {
    const card = analysisCard(makeEvent({ kind: 'analysis', details: { alert: 'opportunity', opportunity: 65, risk: 'LOW', marketCapUsd: 631_000, liquidityUsd: 114_000, holderCount: 5_022 } }));
    assert.equal(card.side.big, '65');
    assert.ok(card.stats.some((s) => s.label === 'ผู้ถือ'));
  });

  it('formats clock time in a given zone', () => {
    assert.equal(clockTime(NOW, 'Asia/Bangkok'), '01:13');
    assert.equal(clockTime(NOW, 'Europe/Kiev'), '20:13');
  });
});

describe('card SVG', () => {
  it('escapes token names (anyone can name a token)', () => {
    const svg = buildCardSvg({ badge: 'X', accent: 'green', title: '<script>alert(1)</script>', stats: [], side: { top: 'a', big: '1', bottom: 'b' } });
    assert.ok(!svg.includes('<script>'));
    assert.ok(svg.includes('&lt;script&gt;'));
  });

  it('clips long text with an ellipsis', () => {
    assert.equal(clip('abcdefghij', 5), 'abcd…');
    assert.equal(clip('ab', 5), 'ab');
  });
});

describe('card renderer', () => {
  it('returns null without a background picture', async () => {
    assert.equal(await createCardRenderer(join(tmpdir(), 'does-not-exist.webp')), null);
  });

  it('draws a JPEG card on top of the background', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-'));
    const bg = join(dir, 'bg.png');
    writeFileSync(bg, await sharp({ create: { width: 640, height: 361, channels: 3, background: '#0a3' } }).png().toBuffer());
    const render = await createCardRenderer(bg);
    const jpeg = await render!({ badge: 'NEW TOKEN', accent: 'gold', title: '$A', stats: [{ label: 'x', value: '1' }], side: { top: 'a', big: 'NEW', bottom: 'b' } });
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
    const meta = await sharp(jpeg).metadata();
    assert.equal(meta.width, 1280, "a small picture is drawn at the minimum width");
  });
});

describe('Discord upload with a card', () => {
  it('sends JSON without files and multipart with the card attached', async () => {
    const plain = requestBody({ embeds: [] });
    assert.equal(typeof plain.body, 'string');
    const withFile = requestBody({ embeds: [{ title: 't', color: 0, fields: [], image: { url: 'attachment://card.jpg' } }], files: [{ name: 'card.jpg', data: new Uint8Array([1, 2]), contentType: 'image/jpeg' }] });
    assert.ok(withFile.body instanceof FormData);
    const json = JSON.parse(String((withFile.body as FormData).get('payload_json')));
    assert.deepEqual(json.attachments, [{ id: 0, filename: 'card.jpg' }]);
    assert.deepEqual(json.allowed_mentions, { parse: [] });
    assert.ok((withFile.body as FormData).get('files[0]') instanceof Blob);
    assert.equal(withFile.headers['content-type'], undefined);
  });

  async function deliver(renderCard: (() => Promise<Buffer>) | undefined): Promise<RequestInit | undefined> {
    let sent: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => { sent = init; return new Response(JSON.stringify({ id: '175928847299117063' })); }) as typeof fetch;
    const repo = createEventRepository(openDatabase(':memory:'));
    const event: RadarEvent = makeEvent({ details: { platform: 'Pump.fun', devBuySol: 5 } });
    repo.insert(event);
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_DEFAULT: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn, renderCard });
    await notifier.handle(event);
    return sent;
  }

  it('attaches the rendered card to a new token alert', async () => {
    const init = await deliver(async () => Buffer.from([0xff, 0xd8, 0xff]));
    assert.ok(init?.body instanceof FormData);
    const json = JSON.parse(String((init.body as FormData).get('payload_json')));
    assert.equal(json.embeds[0].image.url, 'attachment://card.jpg', 'card sits inside the embed frame');
    assert.deepEqual(json.attachments, [{ id: 0, filename: 'card.jpg' }]);
    assert.ok((init.body as FormData).get('files[0]') instanceof Blob);
    assert.equal(json.embeds.length, 1);
    assert.equal(json.embeds[0].title, undefined, 'the card carries the title: no duplicate text');
    assert.deepEqual(json.embeds[0].fields, []);
    assert.ok(json.embeds[0].description.includes('```GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump```'), 'contract stays copyable');
    assert.ok(json.embeds[0].description.includes('Pump.fun'), 'links stay clickable');
    assert.match(json.embeds[0].description, /⏱️ ตรวจพบ <t:\d+:R>/, 'live "x minutes ago" stays as Discord text');
    assert.match(json.embeds[0].description, /🐣 สร้างเมื่อ <t:\d+:R>/, 'a new token shows its age');
  });

  it('still sends the alert (as plain JSON) when the card cannot be drawn', async () => {
    const init = await deliver(async () => { throw new Error('boom'); });
    assert.equal(typeof init?.body, 'string');
  });

  it('shows how long ago a traded coin was launched, from the stored launch', async () => {
    let sent: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => { sent = init; return new Response(JSON.stringify({ id: '175928847299117063' })); }) as typeof fetch;
    const repo = createEventRepository(openDatabase(':memory:'));
    const launchedAt = Date.parse('2026-11-25T10:00:00Z');
    repo.insert(makeEvent({ key: 'launch', kind: 'token_launched', tokenAddress: 'Mint111', detectedAt: launchedAt }));
    const trade = makeEvent({ key: 'trade', kind: 'wallet_trade', tokenAddress: 'Mint111', detectedAt: launchedAt + 3 * 3_600_000, details: { side: 'BUY', wallet: 'w1', tokenAmount: 1, quoteAmount: 1, quoteSymbol: 'SOL', usdValue: 200 } });
    repo.insert(trade);
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_DEFAULT: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn, renderCard: async () => Buffer.from([0xff, 0xd8]) });
    await notifier.handle(trade);
    const json = JSON.parse(String((sent?.body as FormData).get('payload_json')));
    assert.ok(json.embeds[0].description.includes(`🐣 สร้างเมื่อ <t:${launchedAt / 1000}:R>`), json.embeds[0].description);
  });
});

describe('tokenCreatedAt', () => {
  it('is the earliest launch or pair event of the token (EVM case-insensitive), else null', () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const checksummed = '0x858C836Be5bD0511226D93CBc69a9d641A60cd6b';
    repo.insert(makeEvent({ key: 'p1', kind: 'pair_created', chain: 'base', tokenAddress: checksummed, detectedAt: 5_000 }));
    repo.insert(makeEvent({ key: 'p2', kind: 'pair_created', chain: 'base', tokenAddress: checksummed, detectedAt: 9_000 }));
    assert.equal(repo.tokenCreatedAt('base', checksummed.toLowerCase()), 5_000, 'trades store lower-case, pairs checksummed');
    assert.equal(repo.tokenCreatedAt('base', checksummed), 5_000);
    assert.equal(repo.tokenCreatedAt('base', '0x0000000000000000000000000000000000000001'), null);
    assert.equal(repo.tokenCreatedAt('solana', 'Mint111'), null);
  });
});

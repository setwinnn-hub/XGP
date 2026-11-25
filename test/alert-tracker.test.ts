import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAlertTracker } from '../src/analysis/alert-tracker.ts';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { DiscordPayload } from '../src/notify/discord-client.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { makeEvent } from './helpers.ts';

const HOUR = 3_600_000;
/** 2026-11-26 03:00 Bangkok (UTC+7) = 2026-11-25T20:00Z. */
const T0 = Date.parse('2026-11-25T20:00:00Z');

function market(priceUsd: number): MarketSnapshot {
  return {
    pairUrl: 'https://dexscreener.com/solana/p', pairAddress: 'p', dexId: 'raydium', priceUsd, liquidityUsd: 100_000,
    marketCapUsd: 1_000_000, fdvUsd: 1_000_000, volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 },
    priceChangePct: { m5: 0, h1: 0, h24: 0 }, pairCreatedAt: null, socials: 0, websites: 0, imageUrl: null,
  };
}

function setup(prices: Record<string, number>) {
  const db = openDatabase(':memory:');
  const repo = createEventRepository(db);
  const alert = (token: string, symbol: string, price: number, at: number) => repo.insert(makeEvent({
    key: `alert:opportunity:solana:${token}`, kind: 'analysis', chain: 'solana', tokenAddress: token, tokenSymbol: symbol,
    detectedAt: at, details: { alert: 'opportunity', opportunity: 60, risk: 'LOW', priceUsd: price },
  }));
  const sent: DiscordPayload[] = [];
  let now = T0;
  const tracker = createAlertTracker({
    db, logger: silentLogger, now: () => now,
    fetchMarket: async (_chain, token) => (token in prices ? market(prices[token]!) : null),
    send: async (payload) => { sent.push(payload); },
  });
  return { alert, sent, tracker, setNow: (t: number) => { now = t; } };
}

describe('alert follow-ups', () => {
  it('reports the price change 1 hour after an alert, once, in one grouped message', async () => {
    const { alert, sent, tracker, setNow } = setup({ AAA: 1.5, BBB: 0.5 });
    alert('AAA', 'AAA', 1, T0);
    alert('BBB', 'BBB', 1, T0);
    setNow(T0 + 30 * 60_000);
    await tracker.tick();
    assert.equal(sent.length, 0, 'nothing is due before 1 hour');
    setNow(T0 + HOUR + 60_000);
    await tracker.tick();
    assert.equal(sent.length, 1);
    const text = JSON.stringify(sent[0]);
    assert.ok(text.includes('$AAA') && text.includes('+50.0%'), text);
    assert.ok(text.includes('$BBB') && text.includes('-50.0%'), text);
    await tracker.tick();
    assert.equal(sent.length, 1, 'the same checkpoint is never reported twice');
  });

  it('reports the 6 and 24 hour checkpoints later, and skips alerts without a price', async () => {
    const { alert, sent, tracker, setNow } = setup({ AAA: 3 });
    alert('AAA', 'AAA', 1, T0);
    alert('NOPRICE', 'NOP', 0, T0);
    for (const h of [1, 6, 24]) {
      setNow(T0 + h * HOUR + 60_000);
      await tracker.tick();
    }
    const followUps = sent.filter((p) => !JSON.stringify(p).includes('สรุป'));
    assert.equal(followUps.length, 3);
    assert.ok(JSON.stringify(followUps[2]).includes('24 ชม.'));
    assert.ok(!JSON.stringify(sent).includes('NOP'));
  });

  it('does not backfill old checkpoints after a long downtime', async () => {
    const { alert, sent, tracker, setNow } = setup({ AAA: 2 });
    alert('AAA', 'AAA', 1, T0);
    setNow(T0 + 20 * HOUR);
    await tracker.tick();
    const followUps = sent.filter((p) => !JSON.stringify(p).includes('สรุป'));
    assert.equal(followUps.length, 0, '1 h and 6 h checkpoints are long past: skipped, not posted late');
  });
});

describe('daily summary', () => {
  it('posts once a day at 09:00 Bangkok with the last 24 hours of alerts', async () => {
    const { alert, sent, tracker, setNow } = setup({ AAA: 2, BBB: 0.8 });
    alert('AAA', 'AAA', 1, T0);
    alert('BBB', 'BBB', 1, T0 + HOUR);
    const nineAm = Date.parse('2026-11-26T02:05:00Z');
    setNow(Date.parse('2026-11-26T01:55:00Z'));
    await tracker.tick();
    const beforeNine = sent.filter((p) => JSON.stringify(p).includes('สรุป')).length;
    assert.equal(beforeNine, 0);
    setNow(nineAm);
    await tracker.tick();
    const summaries = sent.filter((p) => JSON.stringify(p).includes('สรุป'));
    assert.equal(summaries.length, 1);
    const text = JSON.stringify(summaries[0]);
    assert.ok(text.includes('2 ตัว'), text);
    assert.ok(text.includes('1/2'), text);
    assert.ok(text.includes('+100.0%'), text);
    setNow(nineAm + 30 * 60_000);
    await tracker.tick();
    assert.equal(sent.filter((p) => JSON.stringify(p).includes('สรุป')).length, 1, 'once per day');
  });
});

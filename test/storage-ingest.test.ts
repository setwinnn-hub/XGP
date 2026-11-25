import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEventBus } from '../src/core/bus.ts';
import { HealthRegistry } from '../src/core/health.ts';
import { createIngest } from '../src/core/ingest.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { makeEvent } from './helpers.ts';

describe('EventRepository (SQLite)', () => {
  it('inserts once per key and records delivery and chain time', () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const event = makeEvent();
    assert.equal(repo.insert(event), true);
    assert.equal(repo.insert(event), false);

    repo.setChainTime(event.key, event.detectedAt - 1500);
    repo.recordDelivery(event.key, { status: 'sent', processedAt: event.detectedAt + 10, discordAt: event.detectedAt + 400, note: 'NEW_TOKEN' });

    const [row] = repo.latencyRows(0);
    assert.equal(row?.tChain, event.detectedAt - 1500);
    assert.equal(row?.tDiscord, event.detectedAt + 400);
    assert.equal(row?.delivery, 'sent');
  });

  it('finds the stored name of a token', () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    repo.insert(makeEvent());
    assert.deepEqual(repo.findTokenName('solana', 'GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump'), { name: 'Doomed Rocket', symbol: 'DOOROC' });
    assert.equal(repo.findTokenName('solana', 'unknown'), null);
  });

  it('filters latency rows by time', () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    repo.insert(makeEvent({ key: 'old', detectedAt: 100 }));
    repo.insert(makeEvent({ key: 'new', detectedAt: 10_000 }));
    assert.equal(repo.latencyRows(5_000).length, 1);
  });
});

describe('ingest', () => {
  it('persists and publishes new events once, counting them per source', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const bus = createEventBus(silentLogger);
    const health = new HealthRegistry();
    health.register('pumpportal', 1000);
    const published: RadarEvent[] = [];
    bus.subscribe('test', (event) => { published.push(event); });
    const ingest = createIngest({ repo, bus, health, logger: silentLogger });

    assert.equal(ingest('pumpportal', makeEvent()), true);
    assert.equal(ingest('pumpportal', makeEvent()), false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(published.length, 1);
    assert.equal(health.snapshot()[0]?.events, 1);
  });

  it('keeps going when a bus handler throws', async () => {
    const bus = createEventBus(silentLogger);
    const received: string[] = [];
    bus.subscribe('bad', () => { throw new Error('boom'); });
    bus.subscribe('good', (event) => { received.push(event.key); });
    bus.publish(makeEvent());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ['solana:create:Mint111']);
  });
});

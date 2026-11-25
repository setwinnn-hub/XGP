import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/core/logger.ts';
import { snowflakeToMs } from '../src/core/util.ts';
import { WebhookQueue } from '../src/notify/discord-client.ts';
import { createNotifier } from '../src/notify/notifier.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { fetchStub, jsonResponse, makeEvent, testConfig, WEBHOOK_URL } from './helpers.ts';

const MESSAGE_ID = '175928847299117063';

describe('WebhookQueue', () => {
  it('posts with ?wait=true, blocks mentions and returns Discord receipt time', async () => {
    const stub = fetchStub([() => jsonResponse({ id: MESSAGE_ID })]);
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 10, stub.fn);
    const outcome = await queue.send({ embeds: [] });
    assert.deepEqual(outcome, { status: 'sent', discordAt: snowflakeToMs(MESSAGE_ID) });
    assert.equal(stub.calls[0]?.url, `${WEBHOOK_URL}?wait=true`);
    assert.deepEqual(JSON.parse(stub.calls[0]?.body ?? '{}').allowed_mentions, { parse: [] });
  });

  it('retries after a 429 using retry_after', async () => {
    const stub = fetchStub([() => jsonResponse({ retry_after: 0.01 }, 429), () => jsonResponse({ id: MESSAGE_ID })]);
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 10, stub.fn);
    assert.equal((await queue.send({ embeds: [] })).status, 'sent');
    assert.equal(stub.calls.length, 2);
  });

  it('does not count 429 waits against the failure budget', async () => {
    const limited = (): Response => jsonResponse({ retry_after: 0.001 }, 429);
    const stub = fetchStub([limited, limited, limited, limited, limited, limited, () => jsonResponse({ id: MESSAGE_ID })]);
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 10, stub.fn);
    assert.equal((await queue.send({ embeds: [] })).status, 'sent');
    assert.equal(stub.calls.length, 7);
  });

  it('does not retry client errors such as a deleted webhook', async () => {
    const stub = fetchStub([() => jsonResponse({ message: 'Unknown Webhook' }, 404)]);
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 10, stub.fn);
    const outcome = await queue.send({ embeds: [] });
    assert.equal(outcome.status, 'failed');
    assert.equal(stub.calls.length, 1);
  });

  it('drops messages when the queue is full', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFetch = (async () => { await gate; return jsonResponse({ id: MESSAGE_ID }); }) as typeof fetch;
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 1, slowFetch);
    const first = queue.send({ embeds: [] });
    const second = await queue.send({ embeds: [] });
    assert.equal(second.status, 'dropped');
    release();
    assert.equal((await first).status, 'sent');
  });

  it('pauses when Discord reports the bucket is empty', async () => {
    const stub = fetchStub([
      () => jsonResponse({ id: MESSAGE_ID }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.05' }),
      () => jsonResponse({ id: MESSAGE_ID }),
    ]);
    const queue = new WebhookQueue(WEBHOOK_URL, silentLogger, 10, stub.fn);
    await queue.send({ embeds: [] });
    const started = Date.now();
    await queue.send({ embeds: [] });
    assert.ok(Date.now() - started >= 40);
  });
});

describe('Notifier', () => {
  it('records dry runs when no webhook is configured', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const event = makeEvent();
    repo.insert(event);
    const notifier = createNotifier({ config: testConfig(), repo, logger: silentLogger });
    await notifier.handle(event);
    assert.equal(repo.latencyRows(0)[0]?.delivery, 'dry_run');
    assert.ok(notifier.dryRunCategories().includes('NEW_TOKEN'));
    assert.ok(notifier.dryRunCategories().includes('SYSTEM'));
  });

  it('records filtered events without sending', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const event = makeEvent({ details: { devBuySol: 0.01 } });
    repo.insert(event);
    const stub = fetchStub([() => jsonResponse({ id: MESSAGE_ID })]);
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_NEW_TOKEN: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn: stub.fn });
    await notifier.handle(event);
    assert.equal(stub.calls.length, 0);
    assert.equal(repo.latencyRows(0)[0]?.delivery, 'filtered');
  });

  it('sends alerts and stores Discord receipt time', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    const event = makeEvent();
    repo.insert(event);
    const stub = fetchStub([() => jsonResponse({ id: MESSAGE_ID })]);
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_NEW_TOKEN: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn: stub.fn });
    await notifier.handle(event);
    const [row] = repo.latencyRows(0);
    assert.equal(row?.delivery, 'sent');
    assert.equal(row?.tDiscord, snowflakeToMs(MESSAGE_ID));
  });

  it('names migrations from the stored launch, then from the lookup', async () => {
    const repo = createEventRepository(openDatabase(':memory:'));
    repo.insert(makeEvent());
    const migration = makeEvent({ key: 'solana:migrate:x', kind: 'token_migrated', tokenName: null, tokenSymbol: null });
    repo.insert(migration);
    const stub = fetchStub([() => jsonResponse({ id: MESSAGE_ID })]);
    let lookups = 0;
    const notifier = createNotifier({
      config: testConfig({ DISCORD_WEBHOOK_NEW_TOKEN: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn: stub.fn,
      lookupName: async () => { lookups += 1; return { name: 'Looked Up', symbol: 'LUP' }; },
    });
    await notifier.handle(migration);
    assert.ok(stub.calls[0]?.body?.includes('DOOROC'));
    assert.equal(lookups, 0);

    const unknown = makeEvent({ key: 'solana:migrate:y', kind: 'token_migrated', tokenAddress: 'Other', tokenName: null, tokenSymbol: null });
    repo.insert(unknown);
    await notifier.handle(unknown);
    assert.ok(stub.calls[1]?.body?.includes('LUP'));
  });

  it('sends system messages only to the SYSTEM webhook', async () => {
    const stub = fetchStub([() => jsonResponse({ id: MESSAGE_ID })]);
    const repo = createEventRepository(openDatabase(':memory:'));
    const notifier = createNotifier({ config: testConfig({ DISCORD_WEBHOOK_SYSTEM: WEBHOOK_URL }), repo, logger: silentLogger, fetchFn: stub.fn });
    await notifier.system('ok', true);
    assert.equal(stub.calls.length, 1);
  });
});

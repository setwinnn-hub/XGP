import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePumpPortalMessage } from '../src/chains/solana/pumpportal-parse.ts';
import { LIVE_CREATE_MESSAGE, LIVE_MIGRATE_MESSAGE } from './helpers.ts';

describe('parsePumpPortalMessage', () => {
  it('maps a live create message to token_launched', () => {
    const result = parsePumpPortalMessage(LIVE_CREATE_MESSAGE, 1000);
    assert.equal(result.type, 'event');
    if (result.type !== 'event') return;
    const { event } = result;
    assert.equal(event.kind, 'token_launched');
    assert.equal(event.key, 'solana:create:GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump');
    assert.equal(event.tokenSymbol, 'DOOROC');
    assert.equal(event.details.devBuySol, 0.098765431);
    assert.equal(event.details.mayhemMode, true);
    assert.equal(event.detectedAt, 1000);
    assert.ok(event.links.some((link) => link.url.endsWith(event.txHash)));
  });

  it('maps a live migrate message to token_migrated without inventing a name', () => {
    const result = parsePumpPortalMessage(LIVE_MIGRATE_MESSAGE, 2000);
    assert.equal(result.type, 'event');
    if (result.type !== 'event') return;
    assert.equal(result.event.kind, 'token_migrated');
    assert.equal(result.event.tokenName, null);
    assert.equal(result.event.details.migratedTo, 'pump-amm');
  });

  it('recognizes subscription confirmations', () => {
    const result = parsePumpPortalMessage(JSON.stringify({ message: "Subscribed to 'migration' events." }), 0);
    assert.deepEqual(result, { type: 'control', message: "Subscribed to 'migration' events." });
  });

  it('ignores malformed input instead of throwing', () => {
    assert.equal(parsePumpPortalMessage('not json', 0).type, 'ignored');
    assert.equal(parsePumpPortalMessage('[1,2]', 0).type, 'ignored');
    assert.equal(parsePumpPortalMessage(JSON.stringify({ txType: 'create', mint: 'bad mint!', signature: 'x' }), 0).type, 'ignored');
  });

  it('ignores unknown txTypes', () => {
    const raw = JSON.parse(LIVE_CREATE_MESSAGE) as Record<string, unknown>;
    const result = parsePumpPortalMessage(JSON.stringify({ ...raw, txType: 'buy' }), 0);
    assert.equal(result.type, 'ignored');
  });
});

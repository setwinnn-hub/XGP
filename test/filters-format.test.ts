import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAlert } from '../src/notify/filters.ts';
import { buildSystemAlert, buildTokenAlert, chainLabel, sanitize } from '../src/notify/format.ts';
import { makeEvent, testConfig } from './helpers.ts';

describe('decideAlert', () => {
  it('alerts filtered launches whose dev buy meets the minimum', () => {
    const config = testConfig({ PUMPFUN_MIN_DEV_BUY_SOL: '2' });
    assert.equal(decideAlert(makeEvent({ details: { devBuySol: 2.5 } }), config).alert, true);
    assert.equal(decideAlert(makeEvent({ details: { devBuySol: 0.1 } }), config).alert, false);
  });

  it('alerts filtered launches on a keyword match regardless of dev buy', () => {
    const config = testConfig({ PUMPFUN_KEYWORDS: 'rocket, moon' });
    const decision = decideAlert(makeEvent({ details: { devBuySol: 0 } }), config);
    assert.deepEqual(decision, { alert: true, category: 'NEW_TOKEN', reason: 'keyword "rocket"' });
  });

  it('honors all/off modes', () => {
    assert.equal(decideAlert(makeEvent({ details: {} }), testConfig({ PUMPFUN_NEW_TOKEN_ALERTS: 'all' })).alert, true);
    assert.equal(decideAlert(makeEvent(), testConfig({ PUMPFUN_NEW_TOKEN_ALERTS: 'off' })).alert, false);
  });

  it('alerts migrations unless disabled', () => {
    const event = makeEvent({ kind: 'token_migrated' });
    assert.equal(decideAlert(event, testConfig()).alert, true);
    assert.equal(decideAlert(event, testConfig({ PUMPFUN_MIGRATION_ALERTS: 'false' })).alert, false);
  });

  it('skips EVM pairs without a quote token when configured', () => {
    const event = makeEvent({ kind: 'pair_created', chain: 'base', details: { quoteSymbol: null } });
    assert.equal(decideAlert(event, testConfig()).alert, false);
    assert.equal(decideAlert(event, testConfig({ EVM_QUOTE_PAIRS_ONLY: 'false' })).alert, true);
    assert.equal(decideAlert({ ...event, details: { quoteSymbol: 'WETH' } }, testConfig()).alert, true);
  });
});

describe('sanitize', () => {
  it('neutralizes mentions, markdown and links in attacker-chosen names', () => {
    const out = sanitize('@everyone [click](https://evil.example) **BUY**');
    assert.ok(!out.includes('@everyone'));
    assert.ok(!out.includes('https://'));
    assert.ok(!out.includes('**'));
    assert.ok(!out.includes('['));
  });

  it('truncates long names', () => {
    assert.equal(sanitize('x'.repeat(100), 10).length, 10);
  });
});

describe('buildTokenAlert', () => {
  it('includes contract address, chain, platform and links', () => {
    const payload = buildTokenAlert(makeEvent());
    const embed = payload.embeds[0];
    assert.ok(embed);
    const text = JSON.stringify(embed);
    assert.ok(text.includes('GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump'));
    assert.ok(text.includes('Solana'));
    assert.ok(text.includes('Pump.fun'));
    assert.ok(text.includes('$DOOROC'));
    assert.ok(text.includes('3 SOL'));
  });

  it('says the name is unknown instead of inventing one', () => {
    const text = JSON.stringify(buildTokenAlert(makeEvent({ tokenName: null, tokenSymbol: null, kind: 'token_migrated' })));
    assert.ok(text.includes('ไม่ทราบชื่อ'));
  });

  it('never produces an empty field when a name sanitizes to nothing', () => {
    const payload = buildTokenAlert(makeEvent({ tokenName: '***', tokenSymbol: null, details: { platform: '[]()' } }));
    const embed = payload.embeds[0];
    assert.ok((embed?.fields ?? []).every((field) => field.value.trim().length > 0));
    assert.equal(embed?.title, '🔥 ยังไม่ทราบชื่อเหรียญ');
  });

  it('puts the token in the title, links it, and names the migration venue', () => {
    const launch = buildTokenAlert(makeEvent()).embeds[0];
    assert.equal(launch?.title, '🔥 $DOOROC · Doomed Rocket');
    assert.equal(launch?.url, 'https://pump.fun/coin/x');
    assert.ok(launch?.author?.name.includes('🟣 Solana'));
    assert.ok(launch?.description?.includes('```GwytBanGx9eS55TpbG3w6veLtT8PKRcs3SXiS7nFpump```'));
    const migration = buildTokenAlert(makeEvent({ kind: 'token_migrated', details: { platform: 'Pump.fun', migratedTo: 'pump-amm' } })).embeds[0];
    assert.ok(migration?.description?.includes('PumpSwap'));
  });

  it('labels chains', () => {
    assert.equal(chainLabel('bsc'), 'BNB Chain');
    assert.equal(chainLabel('solana'), 'Solana');
  });

  it('builds system alerts', () => {
    assert.equal(buildSystemAlert('down', false).embeds[0]?.title, '⚠️ ระบบมีปัญหา');
  });
});

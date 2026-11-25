import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnalysisEngine } from '../src/analysis/analysis-engine.ts';
import { fetchSolanaMint, mergeSolanaMint, parseMintAccount } from '../src/analysis/solana-mint.ts';
import type { SecurityReport } from '../src/analysis/security.ts';
import { silentLogger } from '../src/core/logger.ts';
import { createSecurityCache } from '../src/gem/security-cache.ts';
import { assessSecurity } from '../src/gem/security-engine.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** getAccountInfo(jsonParsed) value of a pump.fun Token-2022 mint (ANSEM, seen live 2026-11-25), trimmed. */
const RENOUNCED_2022 = {
  owner: TOKEN_2022,
  data: {
    program: 'spl-token-2022',
    parsed: {
      type: 'mint',
      info: {
        decimals: 6, freezeAuthority: null, mintAuthority: null, isInitialized: true, supply: '997351951240375',
        extensions: [
          { extension: 'metadataPointer', state: { authority: null, metadataAddress: 'x' } },
          { extension: 'tokenMetadata', state: { name: 'The Black Bull', symbol: 'ANSEM', updateAuthority: null } },
        ],
      },
    },
  },
};

/** A Token-2022 mint with every admin power kept (PYUSD's live layout, fee raised for the test). */
const ADMIN_2022 = {
  owner: TOKEN_2022,
  data: {
    program: 'spl-token-2022',
    parsed: {
      type: 'mint',
      info: {
        decimals: 6, freezeAuthority: 'Admin1', mintAuthority: 'Admin2', isInitialized: true, supply: '1',
        extensions: [
          { extension: 'permanentDelegate', state: { delegate: 'Admin1' } },
          {
            extension: 'transferFeeConfig',
            state: {
              newerTransferFee: { epoch: 605, maximumFee: 0, transferFeeBasisPoints: 2500 },
              olderTransferFee: { epoch: 600, maximumFee: 0, transferFeeBasisPoints: 100 },
              transferFeeConfigAuthority: 'Admin1',
            },
          },
          { extension: 'transferHook', state: { authority: 'Admin1', programId: 'HookProgram111' } },
        ],
      },
    },
  },
};

const CLASSIC = {
  owner: TOKEN_CLASSIC,
  data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 9, freezeAuthority: null, mintAuthority: 'Minter', supply: '5' } } },
};

describe('parseMintAccount (getAccountInfo jsonParsed)', () => {
  it('reads a renounced pump.fun Token-2022 mint as safe on every authority', () => {
    const facts = parseMintAccount(RENOUNCED_2022);
    assert.deepEqual(facts, {
      mintable: false, freezable: false, token2022: true, transferFeePct: 0,
      feeChangeable: false, permanentDelegate: false, transferHook: false,
    });
  });

  it('reads kept admin powers, the worst transfer fee and an active transfer hook', () => {
    const facts = parseMintAccount(ADMIN_2022);
    assert.equal(facts?.mintable, true);
    assert.equal(facts?.freezable, true);
    assert.equal(facts?.transferFeePct, 25);
    assert.equal(facts?.feeChangeable, true);
    assert.equal(facts?.permanentDelegate, true);
    assert.equal(facts?.transferHook, true);
  });

  it('treats a transfer hook with no program as inactive', () => {
    const info = { ...ADMIN_2022.data.parsed.info, extensions: [{ extension: 'transferHook', state: { authority: 'A', programId: null } }] };
    const facts = parseMintAccount({ ...ADMIN_2022, data: { ...ADMIN_2022.data, parsed: { type: 'mint', info } } });
    assert.equal(facts?.transferHook, false);
  });

  it('reads a classic SPL mint: no fees, no delegate, no hook are possible', () => {
    const facts = parseMintAccount(CLASSIC);
    assert.equal(facts?.mintable, true);
    assert.equal(facts?.freezable, false);
    assert.equal(facts?.token2022, false);
    assert.equal(facts?.transferFeePct, 0);
    assert.equal(facts?.permanentDelegate, false);
  });

  it('returns null for an account that is not a mint', () => {
    assert.equal(parseMintAccount(null), null);
    assert.equal(parseMintAccount({ owner: TOKEN_CLASSIC, data: { parsed: { type: 'account', info: {} } } }), null);
    assert.equal(parseMintAccount({ owner: 'SomeOtherProgram', data: { parsed: { type: 'mint', info: {} } } }), null);
  });
});

describe('fetchSolanaMint', () => {
  it('asks the RPC for the jsonParsed mint account', async () => {
    let sent: { method?: string; params?: unknown[] } = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as typeof sent;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: RENOUNCED_2022 } }));
    }) as typeof fetch;
    const facts = await fetchSolanaMint('https://rpc.test', 'Mint111', fakeFetch);
    assert.equal(sent.method, 'getAccountInfo');
    assert.deepEqual(sent.params, ['Mint111', { encoding: 'jsonParsed' }]);
    assert.equal(facts?.mintable, false);
  });

  it('throws on an RPC error so callers can log it', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: { message: 'boom' } }))) as unknown as typeof fetch;
    await assert.rejects(fetchSolanaMint('https://rpc.test', 'Mint111', fakeFetch), /boom/);
  });
});

describe('mergeSolanaMint', () => {
  it('builds a verified report from the chain alone when GoPlus gave nothing', () => {
    const report = mergeSolanaMint(null, parseMintAccount(RENOUNCED_2022));
    assert.equal(report?.mintable, false);
    assert.equal(report?.freezable, false);
    assert.equal(report?.ownerCanChangeBalance, false);
    assert.equal(report?.sellTaxPct, 0);
    assert.equal(report?.authoritySource, 'Solana RPC');
  });

  it('lets the chain override stale GoPlus authority flags and maps admin powers to risks', () => {
    const goplus = { mintable: false, freezable: false, ownerCanChangeBalance: false } as SecurityReport;
    const report = mergeSolanaMint(goplus, parseMintAccount(ADMIN_2022));
    assert.equal(report?.mintable, true);
    assert.equal(report?.freezable, true);
    assert.equal(report?.ownerCanChangeBalance, true);
    assert.equal(report?.sellTaxPct, 25);
    assert.equal(report?.transferPausable, true);
  });

  it('keeps the GoPlus report unchanged when the chain could not be read', () => {
    const goplus = { mintable: true } as SecurityReport;
    assert.equal(mergeSolanaMint(goplus, null), goplus);
    assert.equal(mergeSolanaMint(null, null), null);
  });
});

describe('AnalysisEngine with on-chain Solana mint facts', () => {
  function engine(mint: unknown, goplus: () => Promise<SecurityReport | null>) {
    return new AnalysisEngine({
      config: { delaysMin: [0], minOpportunity: 70 }, repo: createEventRepository(openDatabase(':memory:')),
      logger: silentLogger, ingest: () => false,
      fetchMarket: async () => null, fetchSecurity: goplus,
      fetchSolanaMint: async () => parseMintAccount(mint),
    });
  }
  const ref = { chain: 'solana' as const, token: 'Mint111', symbol: null, name: null };

  it('still checks the contract when GoPlus is rate limited', async () => {
    const e = engine(RENOUNCED_2022, async () => { throw new Error('GoPlus code 4029 too many requests'); });
    const { security, score } = await e.analyse(ref);
    assert.equal(security?.mintable, false);
    assert.ok(!score.risks.some((r) => r.includes('ตรวจความปลอดภัยของ contract ไม่ได้')), score.risks.join('\n'));
  });

  it('raises the risk when the chain shows a freeze authority GoPlus missed', async () => {
    const e = engine(ADMIN_2022, async () => ({ mintable: false, freezable: false, ownerCanChangeBalance: false } as SecurityReport));
    const { score } = await e.analyse(ref);
    assert.equal(score.risk, 'HIGH');
    assert.ok(score.risks.some((r) => r.includes('freeze')));
  });

  it('does not read the Solana chain for EVM tokens', async () => {
    let calls = 0;
    const e = new AnalysisEngine({
      config: { delaysMin: [0], minOpportunity: 70 }, repo: createEventRepository(openDatabase(':memory:')),
      logger: silentLogger, ingest: () => false, fetchMarket: async () => null, fetchSecurity: async () => null,
      fetchSolanaMint: async () => { calls += 1; return null; },
    });
    await e.analyse({ chain: 'bsc', token: '0xabc', symbol: null, name: null });
    assert.equal(calls, 0);
  });
});

describe('Gem security cache with on-chain Solana mint facts', () => {
  it('fills authorities from the chain when GoPlus fails, and skips the chain for EVM', async () => {
    let mintCalls = 0;
    const cache = createSecurityCache({
      logger: silentLogger,
      fetchSecurity: async () => { throw new Error('GoPlus code 4029 too many requests'); },
      fetchHoneypot: async () => null,
      fetchSolanaMint: async () => { mintCalls += 1; return parseMintAccount(RENOUNCED_2022); },
    });
    const sol = await cache.get('solana', 'Mint111', true);
    assert.equal(sol.goplus?.mintable, false);
    assert.equal(sol.goplus?.authoritySource, 'Solana RPC');
    const evm = await cache.get('bsc', '0xabc', true);
    assert.equal(evm.goplus, null);
    assert.equal(mintCalls, 1);
  });
});

describe('Solana security checks with on-chain facts', () => {
  it('passes authority and tax checks from the chain and names the source', () => {
    const goplus = mergeSolanaMint(null, parseMintAccount(RENOUNCED_2022));
    const result = assessSecurity({ chain: 'solana', poolKind: 'pair', goplus, honeypot: null, liquidityFlags: [] });
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    assert.equal(byId.get('mintable')?.status, 'PASS');
    assert.equal(byId.get('freezable')?.status, 'PASS');
    assert.equal(byId.get('owner_change_balance')?.status, 'PASS');
    assert.equal(byId.get('sell_tax')?.status, 'PASS');
    assert.deepEqual(byId.get('mintable')?.sources, ['Solana RPC']);
  });

  it('fails critical checks for a freeze authority and a permanent delegate', () => {
    const goplus = mergeSolanaMint(null, parseMintAccount(ADMIN_2022));
    const result = assessSecurity({ chain: 'solana', poolKind: 'pair', goplus, honeypot: null, liquidityFlags: [] });
    assert.equal(result.level, 'CRITICAL');
    assert.ok(result.reasons.some((r) => r.includes('Freeze authority')));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHolderLookup, parseHolders } from '../src/analysis/holders.ts';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import { scoreToken } from '../src/analysis/score.ts';
import { buildAnalysisAlert } from '../src/notify/format-analysis.ts';
import { makeEvent } from './helpers.ts';

const NOW = 1_795_600_000_000;

/** GeckoTerminal /networks/solana/tokens/{addr}/info, seen live 2026-11-26, trimmed. */
const INFO = (count: number, top10: string) => ({
  data: { attributes: { symbol: 'X', holders: { count, distribution_percentage: { top_10: top10, '11_20': '3.7', rest: '32.1' }, last_updated: '2026-11-25T22:31:16Z' } } },
});

const M: MarketSnapshot = {
  pairUrl: '', pairAddress: null, dexId: 'raydium', priceUsd: 1, liquidityUsd: 10_000, marketCapUsd: 100_000, fdvUsd: 100_000,
  volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 }, priceChangePct: { m5: 0, h1: 0, h24: 0 },
  pairCreatedAt: null, socials: 0, websites: 0, imageUrl: null,
};
const ctx = { smartMoneyBuyers: 0, newsMentions: 0, now: NOW };

describe('parseHolders', () => {
  it('reads holder count and the top-10 share', () => {
    assert.deepEqual(parseHolders(INFO(156_629, '59.4345')), { count: 156_629, top10Pct: 59.4345 });
  });

  it('returns null when GeckoTerminal has no holder data', () => {
    assert.equal(parseHolders({ data: { attributes: { holders: null } } }), null);
    assert.equal(parseHolders(null), null);
  });

  it('keeps the count when the distribution is missing', () => {
    assert.deepEqual(parseHolders({ data: { attributes: { holders: { count: 12 } } } }), { count: 12, top10Pct: null });
  });
});

describe('createHolderLookup', () => {
  it('calls the token info endpoint once per token and caches the answer', async () => {
    const urls: string[] = [];
    const lookup = createHolderLookup({
      gapMs: 0, fetchFn: (async (url: string) => { urls.push(url); return new Response(JSON.stringify(INFO(5_038, '27.725'))); }) as typeof fetch,
    });
    assert.deepEqual(await lookup('solana', 'Mint111'), { count: 5_038, top10Pct: 27.725 });
    await lookup('solana', 'Mint111');
    assert.deepEqual(urls, ['https://api.geckoterminal.com/api/v2/networks/solana/tokens/Mint111/info']);
  });

  it('uses GeckoTerminal network ids and returns null on errors or unknown chains', async () => {
    const urls: string[] = [];
    const lookup = createHolderLookup({ gapMs: 0, fetchFn: (async (url: string) => { urls.push(url); return new Response('no', { status: 429 }); }) as typeof fetch });
    assert.equal(await lookup('ethereum', '0xABC'), null);
    assert.equal(urls[0], 'https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xabc/info');
    assert.equal(await lookup('offchain', 'x'), null);
  });
});

describe('scoreToken with holder data', () => {
  it('flags a very concentrated supply as HIGH and a concentrated one as MEDIUM', () => {
    const high = scoreToken(M, null, { ...ctx, holders: { count: 3_000, top10Pct: 85 } });
    assert.ok(high.risks.some((r) => r.startsWith('[HIGH]') && r.includes('85%')), high.risks.join('\n'));
    const medium = scoreToken(M, null, { ...ctx, holders: { count: 3_000, top10Pct: 65 } });
    assert.ok(medium.risks.some((r) => r.startsWith('[MEDIUM]') && r.includes('65%')), medium.risks.join('\n'));
  });

  it('flags very few holders', () => {
    const s = scoreToken(M, null, { ...ctx, holders: { count: 40, top10Pct: 30 } });
    assert.ok(s.risks.some((r) => r.includes('40 ราย')), s.risks.join('\n'));
  });

  it('gives points for a wide, spread-out holder base', () => {
    const plain = scoreToken(M, null, ctx);
    const wide = scoreToken(M, null, { ...ctx, holders: { count: 5_038, top10Pct: 27.7 } });
    assert.equal(wide.rawOpportunity - plain.rawOpportunity, 5);
    assert.ok(wide.positives.some((p) => p.includes('5,038')));
  });
});

describe('analysis alert shows holders', () => {
  it('adds a holders cell when the analysis stored them', () => {
    const event = makeEvent({ kind: 'analysis', chain: 'solana', details: { alert: 'opportunity', opportunity: 60, risk: 'LOW', positives: '[]', risks: '[]', holderCount: 5_038, top10Pct: 27.7 } });
    const text = JSON.stringify(buildAnalysisAlert(event).embeds[0]?.fields);
    assert.ok(text.includes('5,038'));
    assert.ok(text.includes('27.7%'));
  });
});

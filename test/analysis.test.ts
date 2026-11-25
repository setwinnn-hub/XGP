import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnalysisEngine, tokenToAnalyse } from '../src/analysis/analysis-engine.ts';
import { pickBestPair, type MarketSnapshot } from '../src/analysis/market.ts';
import { scoreToken } from '../src/analysis/score.ts';
import { parseSecurity, type SecurityReport } from '../src/analysis/security.ts';
import { rankScore, rankWallets, type TradeRecord } from '../src/analysis/smart-money.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { decideAlert } from '../src/notify/filters.ts';
import { buildAnalysisAlert } from '../src/notify/format-analysis.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { makeEvent, testConfig } from './helpers.ts';

const NOW = 1_795_600_000_000;

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    pairUrl: 'https://dexscreener.com/bsc/0xpair', pairAddress: '0xpair', dexId: 'pancakeswap', priceUsd: 0.01,
    liquidityUsd: 80_000, marketCapUsd: 900_000, fdvUsd: 900_000,
    volumeUsd: { m5: 12_000, h1: 60_000, h24: 200_000 }, txnsH1: { buys: 120, sells: 40 },
    priceChangePct: { m5: 3, h1: 45, h24: 80 }, pairCreatedAt: NOW - 3_600_000, socials: 2, websites: 1, imageUrl: null,
    ...overrides,
  };
}

const SAFE: SecurityReport = {
  honeypot: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 0, mintable: false, freezable: null,
  ownerCanChangeBalance: false, hiddenOwner: false, transferPausable: false, openSource: true,
  holderCount: 800, top10HoldersPct: 22, creatorPct: 1,
};

describe('scoreToken', () => {
  it('scores strong, safe early signals high with reasons', () => {
    const score = scoreToken(market(), SAFE, { smartMoneyBuyers: 2, newsMentions: 1, now: NOW });
    assert.equal(score.risk, 'LOW');
    assert.ok(score.opportunity >= 70, String(score.opportunity));
    assert.ok(score.positives.some((p) => p.includes('Wallet ที่ติดตาม 2 ตัว')));
  });

  it('caps the score of a honeypot near zero and explains why', () => {
    const score = scoreToken(market(), { ...SAFE, honeypot: true }, { smartMoneyBuyers: 2, newsMentions: 0, now: NOW });
    assert.equal(score.risk, 'CRITICAL');
    assert.ok(score.opportunity <= 5);
    assert.ok(score.rawOpportunity >= 40);
    assert.ok(score.risks[0]?.includes('Honeypot'));
  });

  it('flags a market cap far above liquidity and absurd price moves (real fake-TRUMP pattern)', () => {
    const fake = market({ liquidityUsd: 41_768, marketCapUsd: 7_909_524_761, priceChangePct: { m5: -10, h1: 1.4e13, h24: 1e13 } });
    const score = scoreToken(fake, { ...SAFE, openSource: false, holderCount: 3 }, { smartMoneyBuyers: 1, newsMentions: 0, now: NOW });
    assert.equal(score.risk, 'HIGH');
    assert.ok(score.risks.some((r) => r.includes('$7.91B')));
    assert.ok(score.opportunity <= 40);
  });

  it('treats missing data as a medium risk instead of assuming safety', () => {
    const score = scoreToken(null, null, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.equal(score.risk, 'MEDIUM');
    assert.equal(score.opportunity, 0);
  });

  it('does not flag low liquidity for tokens still on the Pump.fun bonding curve', () => {
    const score = scoreToken(market({ dexId: 'pumpfun', liquidityUsd: null, marketCapUsd: 5_000 }), SAFE, { smartMoneyBuyers: 0, newsMentions: 0, now: NOW });
    assert.ok(!score.risks.some((r) => r.includes('สภาพคล่อง')));
  });
});

describe('GoPlus and DexScreener parsing (shapes seen live 2026-11-25)', () => {
  it('parses EVM security and excludes pool/burn addresses from holder concentration', () => {
    const report = parseSecurity({
      is_honeypot: '0', buy_tax: '0', sell_tax: '0.12', is_mintable: '1', is_open_source: '0', holder_count: '3',
      creator_percent: '0.000000',
      holders: [
        { address: '0xpool', tag: 'PancakeV2', percent: '0.99' },
        { address: '0xa', tag: '', percent: '0.006' },
        { address: '0xb', tag: '', percent: '0.004' },
      ],
    }, false);
    assert.equal(report.honeypot, false);
    assert.ok(Math.abs((report.sellTaxPct ?? 0) - 12) < 1e-9);
    assert.equal(report.mintable, true);
    assert.equal(report.openSource, false);
    assert.equal(report.holderCount, 3);
    assert.ok(Math.abs((report.top10HoldersPct ?? 0) - 1) < 1e-9);
    assert.equal(parseSecurity({ sell_tax: '' }, false).sellTaxPct, null);
  });

  it('parses Solana token-program authorities', () => {
    const report = parseSecurity({ mintable: { status: '1', authority: ['x'] }, freezable: { status: '0' }, balance_mutable_authority: { status: '0' } }, true);
    assert.equal(report.mintable, true);
    assert.equal(report.freezable, false);
    assert.equal(report.ownerCanChangeBalance, false);
  });

  it('picks the most liquid pair of the requested token', () => {
    const pairs = [
      { baseToken: { address: '0xT' }, liquidity: { usd: 1_000 }, volume: { h24: 99 }, url: 'https://a', dexId: 'x' },
      { baseToken: { address: '0xt' }, liquidity: { usd: 9_000 }, volume: { h24: 1 }, url: 'https://b', dexId: 'y', info: { imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/x.png' } },
      { baseToken: { address: '0xOther' }, liquidity: { usd: 1e9 } },
    ];
    const best = pickBestPair(pairs, '0xT');
    assert.equal(best?.pairUrl, 'https://b');
    assert.equal(best?.imageUrl, 'https://dd.dexscreener.com/ds-data/tokens/x.png');
    const foreign = pickBestPair([{ baseToken: { address: '0xT' }, info: { imageUrl: 'https://attacker.example/x.png' } }], '0xT');
    assert.equal(foreign?.imageUrl, null);
    assert.equal(pickBestPair([], '0xT'), null);
  });
});

describe('AnalysisEngine', () => {
  function engine(security: SecurityReport, m: MarketSnapshot = market()) {
    const repo = createEventRepository(openDatabase(':memory:'));
    const ingested: RadarEvent[] = [];
    let now = NOW;
    const e = new AnalysisEngine({
      config: { delaysMin: [0], minOpportunity: 70 }, repo, logger: silentLogger, now: () => now,
      ingest: (_name, event) => { ingested.push(event); return repo.insert(event); },
      fetchMarket: async () => m, fetchSecurity: async () => security,
    });
    return { e, repo, ingested, advance: (ms: number) => { now += ms; } };
  }

  it('stores every analysis and raises one opportunity alert per token', async () => {
    const { e, repo, ingested } = engine(SAFE);
    repo.insert(makeEvent({ key: 't1', kind: 'wallet_trade', chain: 'bsc', tokenAddress: '0xabc', details: { wallet: 'w1', side: 'BUY' } }));
    repo.insert(makeEvent({ key: 't2', kind: 'wallet_trade', chain: 'bsc', tokenAddress: '0xabc', details: { wallet: 'w2', side: 'BUY' } }));
    const ref = { chain: 'bsc' as const, token: '0xabc', symbol: 'ABC', name: null };
    e.schedule(ref);
    e.schedule(ref);
    e.start();
    await new Promise((resolve) => setTimeout(resolve, 5_600));
    e.stop();
    assert.equal(ingested.filter((x) => x.key.startsWith('analysis:')).length, 1);
    const alerts = ingested.filter((x) => x.key === 'alert:opportunity:bsc:0xabc');
    assert.equal(alerts.length, 1);
    assert.equal(decideAlert(alerts[0] as RadarEvent, testConfig()).alert, true);
  });

  it('never raises an opportunity alert before GoPlus has checked the contract', async () => {
    const unknown: SecurityReport = { ...SAFE, honeypot: null, mintable: null, freezable: null, ownerCanChangeBalance: null, openSource: null };
    const { e, repo, ingested } = engine(unknown);
    repo.insert(makeEvent({ key: 't1', kind: 'wallet_trade', chain: 'bsc', tokenAddress: '0xabc', details: { wallet: 'w1', side: 'BUY' } }));
    repo.insert(makeEvent({ key: 't2', kind: 'wallet_trade', chain: 'bsc', tokenAddress: '0xabc', details: { wallet: 'w2', side: 'BUY' } }));
    e.schedule({ chain: 'bsc', token: '0xABC', symbol: 'ABC', name: null });
    e.start();
    await new Promise((resolve) => setTimeout(resolve, 5_600));
    e.stop();
    assert.equal(ingested.filter((x) => x.key.startsWith('alert:opportunity')).length, 0);
    assert.ok(ingested.some((x) => x.key === 'analysis:bsc:0xabc:0'), 'EVM keys are lower-case');
  });

  it('warns about a risky token only when it is getting attention', async () => {
    const { e } = engine({ ...SAFE, honeypot: true });
    const result = await e.analyse({ chain: 'bsc', token: '0xabc', symbol: null, name: null });
    assert.equal(result.score.risk, 'CRITICAL');
    const quiet = engine({ ...SAFE, honeypot: true }, market({ volumeUsd: { m5: 0, h1: 0, h24: 0 }, txnsH1: { buys: 0, sells: 0 }, priceChangePct: { m5: 0, h1: 0, h24: 0 }, socials: 0, websites: 0, pairCreatedAt: null }));
    const quietResult = await quiet.e.analyse({ chain: 'bsc', token: '0xabc', symbol: null, name: null });
    assert.ok(quietResult.score.rawOpportunity < 40);
  });

  it('only analyses alerted tokens and followed-wallet buys', () => {
    assert.ok(tokenToAnalyse(makeEvent({ kind: 'wallet_trade', details: { side: 'BUY' } }), false));
    assert.equal(tokenToAnalyse(makeEvent({ kind: 'wallet_trade', details: { side: 'SELL' } }), true), null);
    assert.equal(tokenToAnalyse(makeEvent({ kind: 'pair_created' }), false), null);
    assert.ok(tokenToAnalyse(makeEvent({ kind: 'token_migrated' }), true));
  });

  it('formats opportunity and risk alerts', () => {
    const event = makeEvent({ kind: 'analysis', chain: 'bsc', txHash: 'https://dexscreener.com/bsc/x', details: {
      alert: 'risk', opportunity: 5, risk: 'CRITICAL', positives: '["Volume สูง"]', risks: '["[CRITICAL] Honeypot"]', liquidityUsd: 41_768, marketCapUsd: 7.9e9, smartBuyers: 1,
    } });
    const embed = buildAnalysisAlert(event).embeds[0];
    assert.ok(embed?.title.startsWith('🚨 HIGH RISK'));
    assert.ok(embed?.description?.includes('Honeypot'));
    assert.ok(JSON.stringify(embed?.fields).includes('$7.90B'));
    assert.equal(decideAlert(event, testConfig()).alert, true);
    assert.equal(decideAlert({ ...event, details: { ...event.details, alert: 'none' } }, testConfig()).alert, false);
  });
});

describe('smart money ranking', () => {
  const t = (side: 'BUY' | 'SELL', token: string, amount: number, usd: number | null, minute: number, wallet = 'w1'): TradeRecord =>
    ({ wallet, label: null, chain: 'bsc', token, symbol: null, side, tokenAmount: amount, usdValue: usd, at: minute * 60_000 });

  it('computes FIFO realized P/L, win rate and holding time', () => {
    const [s] = rankWallets([
      t('BUY', 'A', 100, 100, 0), t('BUY', 'A', 100, 200, 10), t('SELL', 'A', 150, 450, 30), t('SELL', 'A', 50, 150, 40),
      t('BUY', 'B', 10, 100, 0), t('SELL', 'B', 10, 50, 60),
      t('BUY', 'C', 10, 10, 0), t('SELL', 'C', 10, 40, 5),
    ]);
    assert.ok(s);
    // A: 1st sell cost 100 + 100 (half of 2nd lot) vs 450 → +250; 2nd sell cost 100 vs 150 → +50. B: -50. C: +30.
    assert.equal(s.realizedPnlUsd, 280);
    assert.equal(s.closedStakeUsd, 410);
    assert.equal(s.closedPositions, 3);
    assert.equal(s.wins, 2);
    assert.ok(Math.abs((s.winRatePct ?? 0) - 66.67) < 0.01);
    // A: avg buy 1.5/token, sold at 3.0 (2x). C: bought at 1, sold at 4. B lost.
    assert.equal(s.doubledEntries, 2);
    assert.ok(s.rankScore !== null);
  });

  it('ignores sells of tokens bought before tracking and trades without USD price', () => {
    const [s] = rankWallets([t('SELL', 'X', 10, 500, 1), t('BUY', 'Y', 10, null, 2)]);
    assert.equal(s?.realizedPnlUsd, 0);
    assert.equal(s?.closedPositions, 0);
    assert.equal(s?.unpricedTrades, 1);
    assert.equal(s?.rankScore, null);
  });

  it('does not count a position as closed (or won) while most of it is still held', () => {
    const [s] = rankWallets([t('BUY', 'A', 100, 100, 0), t('SELL', 'A', 1, 5, 1)]);
    assert.equal(s?.closedPositions, 0);
    assert.equal(s?.wins, 0);
  });

  it('does not let unpriced buys distort the cost of later sells', () => {
    const [s] = rankWallets([t('BUY', 'A', 100, null, 0), t('BUY', 'A', 100, 100, 1), t('SELL', 'A', 100, 500, 2), t('SELL', 'A', 100, 120, 3)]);
    // First sell consumes the unpriced lot (no P/L); second sell: cost 100 vs 120 → +20.
    assert.equal(s?.realizedPnlUsd, 20);
  });

  it('does not rank dust-sized track records', () => {
    const dust = [0, 1, 2].flatMap((i) => [t('BUY', `T${i}`, 1, 1, i), t('SELL', `T${i}`, 1, 3, i + 1)]);
    const [s] = rankWallets(dust);
    assert.equal(s?.wins, 3);
    assert.equal(s?.rankScore, null);
  });

  it('keeps one lucky trade from dominating the score', () => {
    assert.ok(rankScore(100, 1_000_000, 3) <= 100);
    assert.ok(rankScore(40, 1_000_000, 3) < rankScore(80, 500, 10));
  });
});

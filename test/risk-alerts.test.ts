import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnalysisEngine } from '../src/analysis/analysis-engine.ts';
import type { MarketSnapshot } from '../src/analysis/market.ts';
import type { SecurityReport } from '../src/analysis/security.ts';
import { silentLogger } from '../src/core/logger.ts';
import type { RadarEvent } from '../src/core/types.ts';
import { openDatabase } from '../src/storage/db.ts';
import { createEventRepository } from '../src/storage/event-repo.ts';
import { makeEvent } from './helpers.ts';

const NOW = 1_795_600_000_000;

/** Busy fake pool: lots of attention, HIGH risk (reported liquidity backed by $22). */
const FAKE: MarketSnapshot = {
  pairUrl: 'https://dexscreener.com/solana/p', pairAddress: 'p', dexId: 'raydium', priceUsd: 0.3, priceNative: 0.3,
  liquidityUsd: 300_000_000, liquidityQuote: 22, marketCapUsd: 300_000_000, fdvUsd: 300_000_000,
  volumeUsd: { m5: 20_000, h1: 80_000, h24: 900_000 }, txnsH1: { buys: 300, sells: 100 },
  priceChangePct: { m5: 1, h1: 40, h24: 90 }, pairCreatedAt: NOW - 3_600_000, socials: 2, websites: 1, imageUrl: null,
};
const SAFE: SecurityReport = {
  honeypot: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 0, mintable: false, freezable: false,
  ownerCanChangeBalance: false, hiddenOwner: false, transferPausable: false, openSource: true,
  holderCount: 800, top10HoldersPct: 22, creatorPct: 1,
};

async function runOnce(ref: { trending?: boolean }, setup?: (repo: ReturnType<typeof createEventRepository>) => void): Promise<RadarEvent[]> {
  const repo = createEventRepository(openDatabase(':memory:'));
  setup?.(repo);
  const ingested: RadarEvent[] = [];
  const e = new AnalysisEngine({
    config: { delaysMin: [0], minOpportunity: 55 }, repo, logger: silentLogger, now: () => NOW,
    ingest: (_n, event) => { ingested.push(event); return repo.insert(event); },
    fetchMarket: async () => FAKE, fetchSecurity: async () => SAFE,
  });
  e.schedule({ chain: 'solana', token: 'Mint111', symbol: 'FAKE', name: null, ...ref });
  e.start();
  await new Promise((resolve) => setTimeout(resolve, 5_600));
  e.stop();
  return ingested.filter((x) => x.key.startsWith('alert:risk'));
}

describe('HIGH RISK alerts (noise control)', () => {
  it('does not post a risk alert for a token that is only on a trending list', async () => {
    assert.equal((await runOnce({ trending: true })).length, 0);
  });

  it('still warns when a followed wallet bought the risky token', async () => {
    const alerts = await runOnce({ trending: true }, (repo) => {
      repo.insert(makeEvent({ key: 't1', kind: 'wallet_trade', chain: 'solana', tokenAddress: 'Mint111', details: { wallet: 'w1', side: 'BUY' } }));
    });
    assert.equal(alerts.length, 1);
  });

  it('still warns when the token had an opportunity alert before and turned risky', async () => {
    const alerts = await runOnce({ trending: true }, (repo) => {
      repo.insert(makeEvent({ key: 'alert:opportunity:solana:Mint111', kind: 'analysis', chain: 'solana', tokenAddress: 'Mint111', details: { alert: 'opportunity' } }));
    });
    assert.equal(alerts.length, 1);
  });

  it('keeps warning about busy risky tokens found by the radar itself (not trending lists)', async () => {
    assert.equal((await runOnce({})).length, 1);
  });
});

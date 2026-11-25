import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/core/logger.ts';
import { createGemAlerts, missingForAlert } from '../src/gem/gem-alerts.ts';
import type { GemClass, GemScore } from '../src/gem/gem-score.ts';
import type { MarketCapReport } from '../src/gem/market-cap.ts';
import type { ScoreRecord } from '../src/gem/score-store.ts';
import { DEFAULT_GEM_SETTINGS } from '../src/gem/settings.ts';
import { createSwapStore } from '../src/gem/swap-store.ts';
import { watchForNewPair } from '../src/gem/watch-policy.ts';
import { createWatchlist } from '../src/gem/watchlist.ts';
import type { DiscordPayload, SendOutcome } from '../src/notify/discord-client.ts';
import { buildEarlyGemAlert, gemLinks } from '../src/notify/format-gem.ts';
import { openDatabase } from '../src/storage/db.ts';

const NOW = 1_795_700_000_000;
const MIN = 60_000;
const TOKEN = '0x00000000000000000000000000000000000000aa';
const FX = { thbPerUsd: 34, at: NOW, source: 'coingecko', validForMs: 600_000 };

const MCAP: MarketCapReport = {
  status: 'VERIFIED', reason: 'ok', method: 'onchain', priceUsd: 0.0001, totalSupply: 1e8, circulatingSupply: 1e8, maxSupply: null,
  circulatingMcapUsd: 10_000, fdvUsd: 10_000, dexMarketCapUsd: 10_000, dexFdvUsd: 10_000, fx: FX, circulatingMcapThb: 340_000, fdvThb: 340_000,
  sources: ['rpc', 'dexscreener'], checkedAt: NOW,
};

function rec(cls: GemClass, score: number, minutes: number, overrides: Partial<ScoreRecord> = {}): ScoreRecord {
  const gem: GemScore = { score, confidence: 90, classification: cls, gateReasons: cls === 'HIGH_POTENTIAL' ? [] : [`reason for ${cls}`], categories: [] };
  return {
    chain: 'bsc', token: TOKEN, symbol: 'GEM', at: NOW + minutes * MIN, gem, marketCap: MCAP, rangePosition: 'IN_RANGE',
    securityLevel: 'NO_ISSUES_FOUND', liquidity: 'OK', activity: 'ACTIVE', accumulation: 'PRE_PUMP',
    snapshot: {
      uniqueBuyers5m: 22, uniqueBuyersGrowth5mPct: 450, buySellRatio15m: 3.2, smartMoneyBuyers60m: 2, trackedWallets: 5,
      liquidityThb: 300_000, exitLiquidityThb: 290_000, volume5mThb: 25_000, priceChangeH1Pct: 12, liquidityFlags: [],
      whyDetected: ['ผู้ซื้ออิสระ 22 ราย/5 นาที'], mainRisks: [], chartUrl: 'https://dexscreener.com/bsc/0xpair',
    },
    ...overrides,
  };
}

function harness(settings = DEFAULT_GEM_SETTINGS) {
  const db = openDatabase(':memory:');
  const watchlist = createWatchlist(db);
  const sent: { category: string; edit: string | null; payload: DiscordPayload }[] = [];
  let clock = NOW;
  let nextId = 1_000_000_000_000_000_00n;
  const listed: string[] = [];
  const alerts = createGemAlerts({
    watchlist, settings: () => settings, logger: silentLogger, now: () => clock,
    links: (chain, token) => gemLinks('bsc', 'https://bscscan.com/token/', token),
    onListed: (r) => listed.push(r.gem.classification),
    send: async (category, payload, edit): Promise<SendOutcome> => {
      sent.push({ category, edit, payload });
      nextId += 1n;
      return { status: 'sent', discordAt: null, messageId: edit ?? String(nextId) };
    },
  });
  const feed = async (r: ScoreRecord): Promise<void> => { clock = r.at; await alerts.onScored(r); };
  return { watchlist, sent, feed, listed };
}

describe('watchlist', () => {
  it('lists a token only after it holds a listed class for two passes, and keeps every move', async () => {
    const h = harness();
    await h.feed(rec('EARLY_WATCH', 45, 0));
    assert.equal(h.watchlist.get('bsc', TOKEN), null, 'one pass is not enough');
    await h.feed(rec('EARLY_WATCH', 46, 1));
    assert.equal(h.watchlist.get('bsc', TOKEN)?.status, 'EARLY_WATCH');
    assert.deepEqual(h.listed, ['EARLY_WATCH']);
    await h.feed(rec('HIGH_POTENTIAL', 75, 2));
    assert.equal(h.watchlist.get('bsc', TOKEN)?.status, 'EARLY_WATCH', 'promotion waits for confirmation');
    await h.feed(rec('HIGH_POTENTIAL', 76, 3));
    assert.equal(h.watchlist.get('bsc', TOKEN)?.status, 'HIGH_POTENTIAL');
    await h.feed(rec('REJECTED', 76, 4, { securityLevel: 'CRITICAL' }));
    assert.equal(h.watchlist.get('bsc', TOKEN)?.status, 'REJECTED', 'risk moves apply at once');
    assert.deepEqual(h.watchlist.events('bsc', TOKEN).map((e) => e.to), ['EARLY_WATCH', 'HIGH_POTENTIAL', 'REJECTED'], 'history is kept');
  });

  it('ignores tokens that never reach a listed class', async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) await h.feed(rec('HIGH_RISK', 20, i));
    assert.equal(h.watchlist.all().length, 0);
    assert.equal(h.sent.length, 0);
  });
});

describe('EARLY GEM alerts', () => {
  it('sends one qualified alert, then edits the same message instead of posting again', async () => {
    const h = harness();
    await h.feed(rec('HIGH_POTENTIAL', 75, 0));
    await h.feed(rec('HIGH_POTENTIAL', 76, 1));
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.category, 'EARLY_GEM');
    assert.equal(h.sent[0]!.edit, null);
    assert.match(h.sent[0]!.payload.embeds[0]!.title, /EARLY GEM DETECTED/);
    const id = h.watchlist.get('bsc', TOKEN)!.messageId!;
    await h.feed(rec('HIGH_POTENTIAL', 77, 3));
    assert.equal(h.sent.length, 1, 'small score change and inside the edit interval: no edit');
    await h.feed(rec('HIGH_POTENTIAL', 85, 7));
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1]!.edit, id, 'the update edits the original message');
  });

  it('edits the message on a downgrade and sends a separate GEM RISK alert when it turns dangerous', async () => {
    const h = harness();
    await h.feed(rec('HIGH_POTENTIAL', 75, 0));
    await h.feed(rec('HIGH_POTENTIAL', 76, 1));
    const id = h.watchlist.get('bsc', TOKEN)!.messageId!;
    await h.feed(rec('REJECTED', 70, 2, { securityLevel: 'CRITICAL', gem: { score: 70, confidence: 90, classification: 'REJECTED', gateReasons: ['⛔ Honeypot'], categories: [] } }));
    const [edit, risk] = h.sent.slice(1);
    assert.equal(edit!.edit, id);
    assert.match(edit!.payload.embeds[0]!.description ?? '', /REJECTED/);
    assert.equal(risk!.category, 'GEM_RISK');
    assert.equal(risk!.edit, null);
  });

  it('does not send a GEM RISK alert when a token is rejected only for leaving the market cap range', async () => {
    const h = harness();
    await h.feed(rec('HIGH_POTENTIAL', 75, 0));
    await h.feed(rec('HIGH_POTENTIAL', 76, 1));
    await h.feed(rec('REJECTED', 60, 2, { rangePosition: 'ABOVE' }));
    assert.deepEqual(h.sent.map((s) => s.category), ['EARLY_GEM', 'EARLY_GEM'], 'original edited, no risk alert');
  });

  it('respects the cooldown: re-qualifying soon after edits instead of posting a new message', async () => {
    const h = harness();
    await h.feed(rec('HIGH_POTENTIAL', 75, 0));
    await h.feed(rec('HIGH_POTENTIAL', 76, 1));
    await h.feed(rec('EARLY_WATCH', 60, 2));
    await h.feed(rec('EARLY_WATCH', 60, 3));
    await h.feed(rec('HIGH_POTENTIAL', 75, 4));
    await h.feed(rec('HIGH_POTENTIAL', 75, 5));
    assert.ok(h.sent.slice(1).every((s) => s.edit !== null), 'no second new message inside 60 minutes');
  });

  it('never sends a qualified alert with key data missing, or when alerts are off', async () => {
    const unverified = rec('HIGH_POTENTIAL', 80, 0, { marketCap: { ...MCAP, status: 'ESTIMATED' } });
    assert.ok(missingForAlert(unverified).includes('market cap ไม่ VERIFIED'));
    const h = harness();
    await h.feed(unverified);
    await h.feed({ ...unverified, at: NOW + MIN });
    assert.equal(h.sent.length, 0);
    const off = harness({ ...DEFAULT_GEM_SETTINGS, gemAlertsEnabled: false });
    await off.feed(rec('HIGH_POTENTIAL', 80, 0));
    await off.feed(rec('HIGH_POTENTIAL', 80, 1));
    assert.equal(off.sent.length, 0);
    assert.equal(off.watchlist.get('bsc', TOKEN)?.status, 'HIGH_POTENTIAL', 'watchlist still tracks it');
  });

  it('lays the message out with the spec fields in baht and real links', () => {
    const p = buildEarlyGemAlert(rec('HIGH_POTENTIAL', 82, 0), gemLinks('bsc', 'https://bscscan.com/token/', TOKEN), NOW);
    const e = p.embeds[0]!;
    const names = e.fields.map((f) => f.name);
    for (const n of ['Market Cap', 'FDV', 'Volume 5M', 'Unique Buyers 5M', 'Unique Buyers Growth', 'Buy/Sell Ratio', 'Smart Money Activity', 'Holder Growth', 'Early Gem Score', 'Data Confidence', 'Why Detected', 'Main Risks', 'Market Cap Verification', 'Security Status']) {
      assert.ok(names.includes(n), `missing field ${n}`);
    }
    assert.equal(e.fields.find((f) => f.name === 'Market Cap')?.value, '฿340,000');
    assert.equal(e.fields.find((f) => f.name === 'Holder Growth')?.value, 'ไม่มีข้อมูล', 'no invented holder data');
    assert.match(e.description ?? '', /\[Chart\]\(https:\/\/dexscreener\.com\/bsc\/0xpair\)/);
    assert.match(e.description ?? '', /\[Explorer\]\(https:\/\/bscscan\.com\/token\//);
    // Discord embed limits: 25 fields, 256-char title, 1024-char field values, 4096-char description, 6000 total.
    assert.ok(e.fields.length <= 25 && e.title.length <= 256 && (e.description ?? '').length <= 4096);
    assert.ok(e.fields.every((f) => f.value.length > 0 && f.value.length <= 1024 && f.name.length <= 256));
    const total = e.title.length + (e.description ?? '').length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) + (e.footer?.text.length ?? 0);
    assert.ok(total <= 6000, `embed is ${total} chars`);
  });
});

describe('watching new pairs and watch priority', () => {
  it('watches a pair from its creation event (V2 address or V4 pool id)', () => {
    const ref = { chain: 'bsc' as const, token: TOKEN, symbol: 'NEW', name: null };
    assert.equal(watchForNewPair(ref, '0x00000000000000000000000000000000000000bb', NOW)?.poolKind, 'pair');
    assert.equal(watchForNewPair(ref, `0x${'ab'.repeat(32)}`, NOW)?.poolKind, 'v4');
    assert.equal(watchForNewPair(ref, null, NOW), null);
    assert.equal(watchForNewPair({ ...ref, chain: 'solana' }, '0x00000000000000000000000000000000000000bb', NOW), null);
  });

  it('keeps watchlist and analysed tokens ahead of brand-new pairs, and only upgrades the reason', () => {
    const store = createSwapStore(openDatabase(':memory:'));
    const base = { chain: 'bsc', pool: '0x00000000000000000000000000000000000000bb', poolKind: 'pair' as const, symbol: null, expiresAt: NOW + 60 * MIN };
    store.watch({ ...base, token: '0x1', reason: 'watchlist', addedAt: NOW - 50 * MIN });
    store.watch({ ...base, token: '0x2', reason: 'analysed', addedAt: NOW - 40 * MIN });
    store.watch({ ...base, token: '0x3', reason: 'new-pair', addedAt: NOW });
    assert.deepEqual(store.activeWatches('bsc', NOW).map((w) => w.token), ['0x1', '0x2', '0x3']);
    store.watch({ ...base, token: '0x1', reason: 'new-pair', addedAt: NOW });
    assert.equal(store.findWatch('bsc', '0x1')?.reason, 'watchlist', 'never downgraded');
    store.watch({ ...base, token: '0x3', reason: 'analysed', addedAt: NOW });
    assert.equal(store.findWatch('bsc', '0x3')?.reason, 'analysed', 'upgraded');
  });
});

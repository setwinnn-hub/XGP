import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTrending, trendingEvent } from '../src/news/coingecko-trending.ts';
import { explainSignals, extractSignals } from '../src/news/extract.ts';
import { NEWS_FEEDS } from '../src/news/feeds.ts';
import { trendEvent } from '../src/news/news-adapter.ts';
import { newsKey, normalizeTitle, toNewsEvent } from '../src/news/news-event.ts';
import { fetchFeed, htmlToText, parseFeed, safeUrl } from '../src/news/rss.ts';
import { isPublicHttpsUrl } from '../src/viral/preview-image.ts';
import { TrendTracker } from '../src/news/trend-tracker.ts';
import { decideAlert } from '../src/notify/filters.ts';
import { buildNewsAlert, buildTrendAlert } from '../src/notify/format-news.ts';
import { fetchStub, testConfig } from './helpers.ts';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title>Ansem Meme Coin Crashes After $2.57 Million Wallet Drain</title><link>https://decrypt.co/1/ansem</link>
<pubDate>Tue, 24 Nov 2026 17:30:00 GMT</pubDate><dc:creator>Jane Doe</dc:creator>
<description><![CDATA[<p>The <b>$ANSEM</b> token fell &amp; holders panicked.</p>]]></description>
<media:content url="https://img.decrypt.co/a.jpg" medium="image"/></item>
<item><title>No link item</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Binance will list $PENGU perpetuals</title><link rel="alternate" href="https://example.com/pengu"/>
<updated>2026-11-24T20:00:00Z</updated><summary>Listing announcement.</summary></entry></feed>`;

const google = NEWS_FEEDS.find((f) => f.id.startsWith('google'));
const decrypt = NEWS_FEEDS.find((f) => f.id === 'decrypt');

describe('RSS/Atom parsing', () => {
  it('parses RSS items with date, author, image and plain-text summary; skips items without links', () => {
    const items = parseFeed(RSS);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.link, 'https://decrypt.co/1/ansem');
    assert.equal(items[0]?.published, Date.parse('2026-11-24T17:30:00Z'));
    assert.equal(items[0]?.author, 'Jane Doe');
    assert.equal(items[0]?.image, 'https://img.decrypt.co/a.jpg');
    assert.equal(items[0]?.summary, 'The $ANSEM token fell & holders panicked.');
  });

  it('parses Atom entries', () => {
    const [entry] = parseFeed(ATOM);
    assert.equal(entry?.link, 'https://example.com/pengu');
    assert.equal(entry?.published, Date.parse('2026-11-24T20:00:00Z'));
  });

  it('returns nothing for non-feed XML and decodes entities', () => {
    assert.deepEqual(parseFeed('<html></html>'), []);
    assert.equal(htmlToText('a&#39;b &#x41; &nbsp;<b>c</b>'), "a'b A c");
  });

  it('survives hostile entities and keeps the other items', () => {
    assert.equal(htmlToText('x &#99999999; &#x110000; y'), 'x &#99999999; &#x110000; y');
    const xml = `<rss><channel><item><title>bad &amp;#x110000; one</title><link>https://a/1</link></item>
      <item><title>good</title><link>https://a/2</link></item></channel></rss>`;
    assert.equal(parseFeed(xml).length, 2);
  });

  it('only accepts https links and encodes characters that could break a markdown link', () => {
    assert.equal(safeUrl('https://a.com/x (1)'), 'https://a.com/x%20%281%29');
    assert.equal(safeUrl('http://a.com'), null);
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl(`https://a.com/${'x'.repeat(3000)}`), null);
  });

  it('uses conditional requests and reports 304 and errors without throwing', async () => {
    const stub = fetchStub([() => new Response(null, { status: 304 })]);
    assert.deepEqual(await fetchFeed('https://f', { etag: '"abc"', lastModified: null }, stub.fn), { status: 'not-modified' });
    const failed = await fetchFeed('https://f', { etag: null, lastModified: null }, fetchStub([() => new Response('', { status: 403 })]).fn);
    assert.deepEqual(failed, { status: 'error', error: 'HTTP 403' });
  });
});

describe('signal extraction', () => {
  it('finds tickers but not dollar amounts or majors', () => {
    const s = extractSignals('$WIF and $BONK pump while $2.57 million and $BTC move', '');
    assert.deepEqual(s.tickers, ['WIF', 'BONK']);
  });

  it('tags listings, hacks and launches and marks meme relevance', () => {
    const listing = extractSignals('Binance will list PEPE perpetual futures', '');
    assert.ok(listing.tags.includes('LISTING'));
    assert.ok(listing.memeRelated);
    assert.ok(extractSignals('Meme coin wallet drained in exploit', '').tags.includes('HACK_RUG'));
    assert.equal(extractSignals('Bitcoin ETF flows rise', '').memeRelated, false);
  });

  it('finds contract addresses and rejects plain long words', () => {
    const s = extractSignals('CA: 3imQapaAZet9BPct2E7sgpkfDsYAEQjKStzVPGRzpump and 0x55ff7C61a0000000000000000000000000000001', '');
    assert.equal(s.addresses.length, 2);
    assert.equal(extractSignals('Supercalifragilisticexpialidociousword', '').addresses.length, 0);
  });

  it('recognizes common meme coin spellings', () => {
    assert.ok(extractSignals('Dogecoin surges 12%', '').memeRelated);
    assert.ok(extractSignals('Dogwifhat holders cheer', '').memeRelated);
    assert.deepEqual(extractSignals('Holders of $TRUMP sold', '').memeNames, ['TRUMP']);
  });

  it('only reads Solana addresses when the text says it is giving one', () => {
    const id = '3imQapaAZet9BPct2E7sgpkfDsYAEQjKStzVPGRzpump';
    assert.equal(extractSignals(`Story ${id}`, '').addresses.length, 0);
    assert.equal(extractSignals(`Contract: ${id}`, '').addresses.length, 1);
  });

  it('blocks preview fetches to internal hosts', () => {
    assert.equal(isPublicHttpsUrl('https://news.example.com/a'), true);
    for (const bad of ['https://localhost/x', 'https://127.0.0.1/', 'https://169.254.169.254/latest', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://[::1]/', 'http://example.com/']) {
      assert.equal(isPublicHttpsUrl(bad), false, bad);
    }
  });

  it('explains why the news matters in Thai, without AI', () => {
    const reasons = explainSignals(extractSignals('Binance lists $PENGU after hack scare', ''));
    assert.ok(reasons.some((r) => r.includes('listing')));
    assert.ok(reasons.some((r) => r.includes('$PENGU')));
  });
});

describe('news events', () => {
  it('collapses the same story from Google News and the original outlet into one key', () => {
    assert.equal(newsKey('What Is Pons? The Robinhood Chain Meme Coin Launchpad Explained - Decrypt'), newsKey('What Is Pons? The Robinhood Chain Meme Coin Launchpad Explained'));
    assert.equal(normalizeTitle('Hello, World! - Reuters'), 'hello world');
  });

  it('splits the publisher out of Google News titles', () => {
    assert.ok(google && decrypt);
    const item = { title: 'Ansem memecoin crashes - CoinDesk', link: 'https://news.google.com/x', published: 1, summary: '', image: null, author: null };
    const { event } = toNewsEvent(google, item, 10);
    assert.equal(event.details.title, 'Ansem memecoin crashes');
    assert.equal(event.details.author, 'CoinDesk');
    assert.equal(event.chain, 'offchain');
  });

  it('alerts only fresh, meme-related, dated news', () => {
    assert.ok(decrypt);
    const now = Date.parse('2026-11-25T00:00:00Z');
    const make = (title: string, published: number | null) => toNewsEvent(decrypt, { title, link: 'https://d/x', published, summary: '', image: null, author: null }, now).event;
    const config = testConfig();
    assert.equal(decideAlert(make('Meme coin rally', now - 30 * 60_000), config, now).alert, true);
    assert.equal(decideAlert(make('Meme coin rally', now - 5 * 60 * 60_000), config, now).alert, false);
    assert.equal(decideAlert(make('Meme coin rally', null), config, now).alert, false);
    assert.equal(decideAlert(make('Bitcoin ETF inflows', now), config, now).alert, false);
  });

  it('formats a readable news alert with reason, coins and image', () => {
    assert.ok(decrypt);
    const { event } = toNewsEvent(decrypt, { title: 'Binance lists $PENGU', link: 'https://d/x', published: 1_000, summary: 'Big listing.', image: null, author: 'A' }, 2_000);
    const embed = buildNewsAlert(event, 'https://img/x.jpg').embeds[0];
    assert.equal(embed?.image?.url, 'https://img/x.jpg');
    assert.ok(embed?.description?.includes('ทำไมข่าวนี้สำคัญ'));
    assert.ok(JSON.stringify(embed?.fields).includes('$PENGU'));
  });
});

describe('TrendTracker', () => {
  const at = (min: number) => min * 60_000;

  it('fires once when a coin is covered by several sources within the window, then cools down', () => {
    const tracker = new TrendTracker({ windowMs: at(60), minMentions: 3, minSources: 2, cooldownMs: at(360) });
    const m = (source: string, minute: number) => tracker.record({ symbol: 'WIF', source, title: 't', link: 'https://x', at: at(minute) });
    assert.equal(m('A', 0), null);
    assert.equal(m('A', 10), null);
    const signal = m('B', 20);
    assert.equal(signal?.mentions, 3);
    assert.deepEqual(signal?.sources, ['A', 'B']);
    assert.equal(m('C', 30), null);
  });

  it('forgets mentions outside the window and needs several sources', () => {
    const tracker = new TrendTracker({ windowMs: at(60), minMentions: 3, minSources: 2, cooldownMs: at(360) });
    tracker.record({ symbol: 'X', source: 'A', title: 't', link: 'https://x', at: at(0) });
    tracker.record({ symbol: 'X', source: 'B', title: 't', link: 'https://x', at: at(5) });
    assert.equal(tracker.record({ symbol: 'X', source: 'A', title: 't', link: 'https://x', at: at(120) }), null);
    const single = new TrendTracker({ windowMs: at(60), minMentions: 2, minSources: 2, cooldownMs: 0 });
    single.record({ symbol: 'Y', source: 'A', title: 't', link: 'https://x', at: 0 });
    assert.equal(single.record({ symbol: 'Y', source: 'A', title: 't', link: 'https://x', at: 1 }), null);
  });

  it('builds a trending alert listing the headlines', () => {
    const event = trendEvent({ symbol: 'WIF', mentions: 3, sources: ['A', 'B'], windowMs: at(60), cooldownMs: at(360), examples: [{ symbol: 'WIF', source: 'A', title: 'WIF soars', link: 'https://a/1', at: 0 }] }, at(10));
    const later = trendEvent({ symbol: 'WIF', mentions: 3, sources: ['A', 'B'], windowMs: at(60), cooldownMs: at(360), examples: [] }, at(200));
    assert.equal(event.key, later.key, 'same cooldown bucket => same key => DB dedupe blocks a repeat after restart');
    const embed = buildTrendAlert(event).embeds[0];
    assert.ok(embed?.title.includes('$WIF'));
    assert.ok(embed?.description?.includes('https://a/1'));
    assert.equal(decideAlert(event, testConfig()).alert, true);
  });
});

describe('CoinGecko trending', () => {
  const body = { coins: [
    { item: { id: 'pudgy-penguins', symbol: 'pengu', name: 'Pudgy Penguins', market_cap_rank: 129, large: 'https://coin-images.coingecko.com/coins/images/1/large/p.png', data: { price_change_percentage_24h: { usd: 12.5 } } } },
    { item: { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1 } },
    { item: { bad: true } },
  ] };

  it('parses coins with position, rank, change and image', () => {
    const coins = parseTrending(body);
    assert.equal(coins.length, 2);
    assert.deepEqual(coins[0], { id: 'pudgy-penguins', symbol: 'PENGU', name: 'Pudgy Penguins', position: 1, marketCapRank: 129, change24hPct: 12.5, image: 'https://coin-images.coingecko.com/coins/images/1/large/p.png' });
    assert.deepEqual(parseTrending({}), []);
  });

  it('formats a trending alert with a link to CoinGecko', () => {
    const [coin] = parseTrending(body);
    assert.ok(coin);
    const embed = buildTrendAlert(trendingEvent(coin, 0)).embeds[0];
    assert.equal(embed?.url, 'https://www.coingecko.com/en/coins/pudgy-penguins');
    assert.ok(JSON.stringify(embed?.fields).includes('+12.5%'));
  });
});

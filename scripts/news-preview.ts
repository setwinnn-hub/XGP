/**
 * Fetches every news feed once and shows what the alert filter would do with each headline.
 * Sends nothing. Usage: npm run news:preview [maxAgeMinutes]
 */
import { loadConfig } from '../src/config.ts';
import { NEWS_FEEDS } from '../src/news/feeds.ts';
import { toNewsEvent } from '../src/news/news-event.ts';
import { fetchFeed } from '../src/news/rss.ts';
import { decideAlert } from '../src/notify/filters.ts';

async function main(): Promise<void> {
  const maxAge = process.argv[2];
  const config = loadConfig(maxAge ? { ...process.env, NEWS_MAX_AGE_MIN: maxAge } : process.env);
  const now = Date.now();
  let alerts = 0;
  for (const feed of NEWS_FEEDS) {
    const result = await fetchFeed(feed.url, { etag: null, lastModified: null });
    if (result.status !== 'ok') {
      process.stdout.write(`${feed.name}: ${result.status}${result.status === 'error' ? ` ${result.error}` : ''}\n`);
      continue;
    }
    const meme = result.items.map((item) => toNewsEvent(feed, item, now)).filter(({ signals }) => signals.memeRelated);
    process.stdout.write(`\n${feed.name}: ${result.items.length} items, ${meme.length} meme-related\n`);
    for (const { event, signals } of meme.slice(0, 8)) {
      const decision = decideAlert(event, config, now);
      if (decision.alert) alerts += 1;
      const age = typeof event.details.published === 'number' ? `${Math.round((now - event.details.published) / 60_000)}m` : '?';
      const coins = [...signals.tickers, ...signals.memeNames].slice(0, 4).join(',');
      process.stdout.write(`  ${decision.alert ? 'ALERT ' : 'skip  '} ${age.padStart(5)} [${signals.tags.join(',')}] {${coins}} ${String(event.details.title).slice(0, 90)}\n`);
    }
  }
  process.stdout.write(`\nWould alert: ${alerts} (max age ${config.news.maxAgeMin} min)\n`);
}

await main();

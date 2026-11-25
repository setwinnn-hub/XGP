import type { AlertCategory, AppConfig } from '../config.ts';
import type { RadarEvent } from '../core/types.ts';

export type AlertDecision =
  | { readonly alert: true; readonly category: AlertCategory; readonly reason: string }
  | { readonly alert: false; readonly reason: string };

type FilterConfig = Pick<AppConfig, 'pumpfun' | 'evmQuotePairsOnly' | 'minTradeUsd' | 'news'>;

function decideNews(event: RadarEvent, config: FilterConfig, now: number): AlertDecision {
  if (event.details.memeRelated !== true) return { alert: false, reason: 'not meme-coin related' };
  const published = event.details.published;
  if (typeof published !== 'number') return { alert: false, reason: 'no publish date (cannot prove it is new)' };
  const ageMin = (now - published) / 60_000;
  if (ageMin > config.news.maxAgeMin) return { alert: false, reason: `old news (${Math.round(ageMin)} min)` };
  return { alert: true, category: 'BREAKING_NEWS', reason: 'fresh meme-coin news' };
}

function decideTrade(event: RadarEvent, config: FilterConfig): AlertDecision {
  const usd = event.details.usdValue;
  if (config.minTradeUsd > 0 && typeof usd === 'number' && usd < config.minTradeUsd) {
    return { alert: false, reason: `trade $${usd.toFixed(2)} below MIN_TRADE_USD` };
  }
  const category = event.details.side === 'SELL' ? 'SMART_MONEY_SELL' : 'SMART_MONEY_BUY';
  return { alert: true, category, reason: 'followed wallet trade' };
}

function matchedKeyword(event: RadarEvent, keywords: readonly string[]): string | null {
  const haystack = `${event.tokenName ?? ''} ${event.tokenSymbol ?? ''}`.toLowerCase();
  return keywords.find((keyword) => haystack.includes(keyword)) ?? null;
}

function decideLaunch(event: RadarEvent, config: FilterConfig): AlertDecision {
  const { newTokenMode, minDevBuySol, keywords } = config.pumpfun;
  if (newTokenMode === 'off') return { alert: false, reason: 'pump.fun launch alerts off' };
  if (newTokenMode === 'all') return { alert: true, category: 'NEW_TOKEN', reason: 'all launches' };
  const keyword = matchedKeyword(event, keywords);
  if (keyword) return { alert: true, category: 'NEW_TOKEN', reason: `keyword "${keyword}"` };
  const devBuy = event.details.devBuySol;
  if (typeof devBuy === 'number' && devBuy >= minDevBuySol) {
    return { alert: true, category: 'NEW_TOKEN', reason: `dev buy ${devBuy.toFixed(2)} SOL >= ${minDevBuySol}` };
  }
  return { alert: false, reason: 'below launch filter' };
}

/** Decides whether an event becomes a Discord alert, and in which category. Pure given `now`. */
export function decideAlert(event: RadarEvent, config: FilterConfig, now: number = Date.now()): AlertDecision {
  switch (event.kind) {
    case 'token_launched':
      return decideLaunch(event, config);
    case 'token_migrated':
      return config.pumpfun.alertMigrations
        ? { alert: true, category: 'NEW_TOKEN', reason: 'pump.fun migration' }
        : { alert: false, reason: 'migration alerts off' };
    case 'pair_created':
      if (config.evmQuotePairsOnly && event.details.quoteSymbol === null) {
        return { alert: false, reason: 'pair has no known quote token' };
      }
      return { alert: true, category: 'NEW_TOKEN', reason: 'new pair' };
    case 'wallet_trade':
      return decideTrade(event, config);
    case 'news':
      return decideNews(event, config, now);
    case 'trending':
      // GeckoTerminal lists ~20 pools per chain: they go to analysis, which alerts only on qualified tokens.
      if (event.details.trendType === 'geckoterminal') return { alert: false, reason: 'geckoterminal trend: analysed, not posted' };
      return { alert: true, category: 'TRENDING', reason: `trend: ${String(event.details.trendType)}` };
    case 'analysis':
      if (event.details.alert === 'opportunity') return { alert: true, category: 'HIGH_OPPORTUNITY', reason: 'score above threshold' };
      if (event.details.alert === 'risk') return { alert: true, category: 'HIGH_RISK', reason: 'high risk on a watched token' };
      return { alert: false, reason: 'analysis record' };
  }
}

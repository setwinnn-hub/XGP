import { ALERT_CATEGORIES, type AlertCategory, type AppConfig } from '../config.ts';
import { errorMessage, type Logger } from '../core/logger.ts';
import type { RadarEvent } from '../core/types.ts';
import { fetchDexScreenerTokenName, type TokenName } from '../enrich/dexscreener.ts';
import type { EventRepository } from '../storage/event-repo.ts';
import { WebhookQueue, type DiscordPayload, type SendOutcome } from './discord-client.ts';
import { decideAlert } from './filters.ts';
import { buildSystemAlert, buildTokenAlert } from './format.ts';
import { buildTradeAlert } from './format-trade.ts';
import { buildNewsAlert, buildTrendAlert } from './format-news.ts';
import { buildAnalysisAlert } from './format-analysis.ts';
import { fetchPreviewImage } from '../viral/preview-image.ts';
import type { CardData } from './card.ts';
import { analysisCard, tokenCard, tradeCard } from './card-data.ts';
import type { CardRenderer } from './card-render.ts';

export interface NotifierDeps {
  readonly config: AppConfig;
  readonly repo: EventRepository;
  readonly logger: Logger;
  readonly fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to DexScreener. */
  readonly lookupName?: (event: RadarEvent) => Promise<TokenName | null>;
  /** Injectable for tests; defaults to reading the article's og:image. */
  readonly previewImage?: (url: string) => Promise<string | null>;
  /** Draws the picture card attached to token, trade and analysis alerts; none = text only. */
  readonly renderCard?: CardRenderer;
}

const CARD_FILE = 'card.jpg';
/** A card that takes longer than this is skipped, so a slow render never delays an alert much. */
const CARD_RENDER_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const NEWS_IMAGE_WAIT_MS = 3_000;

export interface Notifier {
  handle(event: RadarEvent): Promise<void>;
  system(text: string, ok: boolean): Promise<void>;
  dryRunCategories(): readonly AlertCategory[];
  /**
   * Early Gem alerts: posts a new message, or edits `editMessageId` in place. Returns null when
   * the category has no webhook (dry run, logged only).
   */
  gem(category: 'EARLY_GEM' | 'GEM_RISK', payload: DiscordPayload, editMessageId: string | null): Promise<SendOutcome | null>;
  /** Posts a ready-made message (follow-ups, daily summary) to a category's room. */
  post(category: AlertCategory, payload: DiscordPayload): Promise<SendOutcome | null>;
}

/**
 * One queue per webhook URL (not per category): categories that share a channel share
 * Discord's rate limit, so they must share one queue.
 */
function buildQueues(deps: NotifierDeps, logger: Logger): Map<AlertCategory, { url: string; queue: WebhookQueue }> {
  const byUrl = new Map<string, WebhookQueue>();
  const queueFor = (url: string, name: string): WebhookQueue => {
    const existing = byUrl.get(url);
    if (existing) return existing;
    const created = new WebhookQueue(url, logger.child({ webhook: name }), deps.config.maxQueuePerWebhook, deps.fetchFn);
    byUrl.set(url, created);
    return created;
  };
  const entries = ALERT_CATEGORIES.flatMap((category) => {
    const url = deps.config.webhooks[category] ?? deps.config.defaultWebhook;
    return url ? [[category, { url, queue: queueFor(url, category) }] as const] : [];
  });
  return new Map(entries);
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const logger = deps.logger.child({ module: 'notifier' });
  const queues = buildQueues(deps, logger);

  const lookupName = deps.lookupName ?? ((event: RadarEvent) =>
    fetchDexScreenerTokenName(event.chain, event.tokenAddress, deps.fetchFn));

  /** Migration events carry no name: reuse the name stored at launch, else ask DexScreener. */
  const withName = async (event: RadarEvent): Promise<RadarEvent> => {
    if (event.tokenName || event.tokenSymbol) return event;
    const stored = deps.repo.findTokenName(event.chain, event.tokenAddress);
    const found = stored ?? (await lookupName(event).catch((error: unknown) => {
      logger.debug('name lookup failed', { token: event.tokenAddress, error: errorMessage(error) });
      return null;
    }));
    return found ? { ...event, tokenName: found.name, tokenSymbol: found.symbol } : event;
  };

  /** Adds the picture card to the first embed; on any failure or slowness the alert goes without it. */
  const withCard = async (payload: DiscordPayload, card: CardData): Promise<DiscordPayload> => {
    if (!deps.renderCard) return payload;
    try {
      const image = await withTimeout(deps.renderCard(card), CARD_RENDER_TIMEOUT_MS);
      const [first, ...rest] = payload.embeds;
      if (!first) return payload;
      return {
        ...payload,
        embeds: [{ ...first, image: { url: `attachment://${CARD_FILE}` } }, ...rest],
        files: [{ name: CARD_FILE, data: image, contentType: 'image/jpeg' }],
      };
    } catch (error: unknown) {
      logger.warn('card render failed, sending without it', { error: errorMessage(error) });
      return payload;
    }
  };

  const send = async (event: RadarEvent, category: AlertCategory, payload: DiscordPayload, record: boolean): Promise<void> => {
    const processedAt = Date.now();
    const target = queues.get(category);
    const logFields = { key: event.key, chain: event.chain, symbol: event.tokenSymbol, token: event.tokenAddress };
    if (!target) {
      logger.info('ALERT (dry run: no webhook)', { category, ...logFields });
      if (record) deps.repo.recordDelivery(event.key, { status: 'dry_run', processedAt, discordAt: null, note: category });
      return;
    }
    const outcome = await target.queue.send(payload);
    if (outcome.status === 'sent') {
      logger.info('ALERT sent', { category, ...logFields, pipelineMs: (outcome.discordAt ?? Date.now()) - event.detectedAt });
      if (record) deps.repo.recordDelivery(event.key, { status: 'sent', processedAt, discordAt: outcome.discordAt, note: category });
      return;
    }
    logger.error('ALERT not delivered', { category, ...logFields, status: outcome.status, error: outcome.error });
    if (record) deps.repo.recordDelivery(event.key, { status: outcome.status, processedAt, discordAt: null, note: outcome.error });
  };

  /** Picture for a news alert: the feed's own image, else the article's preview image (bounded wait). */
  const newsImage = async (event: RadarEvent): Promise<string | null> => {
    const fromFeed = event.details.image;
    if (typeof fromFeed === 'string' && fromFeed.startsWith('https://')) return fromFeed;
    if (!event.txHash.startsWith('https://')) return null;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), NEWS_IMAGE_WAIT_MS); });
    return Promise.race([(deps.previewImage ?? fetchPreviewImage)(event.txHash), deadline]).finally(() => clearTimeout(timer));
  };

  /** Wallet trades go out first; the whale channel gets a copy only if it is a separate channel. */
  const sendTrade = async (event: RadarEvent, category: AlertCategory): Promise<void> => {
    const usd = event.details.usdValue;
    const isWhale = typeof usd === 'number' && usd >= deps.config.whaleUsd;
    const priorSameSide = deps.repo.countPriorTrades(
      event.chain, String(event.details.wallet), event.tokenAddress, String(event.details.side), event.detectedAt,
    );
    const payload = await withCard(buildTradeAlert(event, { isWhale, priorSameSide }), tradeCard(event, { isWhale, priorSameSide }));
    await send(event, category, payload, true);
    // Copy only to a dedicated WHALE webhook, never to the DEFAULT fallback.
    const whaleUrl = deps.config.webhooks.WHALE;
    if (isWhale && whaleUrl && whaleUrl !== queues.get(category)?.url) await send(event, 'WHALE', payload, false);
  };

  return {
    async handle(event) {
      const decision = decideAlert(event, deps.config);
      if (!decision.alert) {
        return deps.repo.recordDelivery(event.key, { status: 'filtered', processedAt: Date.now(), discordAt: null, note: decision.reason });
      }
      if (event.kind === 'wallet_trade') return sendTrade(event, decision.category);
      if (event.kind === 'trending') return send(event, decision.category, buildTrendAlert(event), true);
      if (event.kind === 'analysis') return send(event, decision.category, await withCard(buildAnalysisAlert(event), analysisCard(event)), true);
      if (event.kind === 'news') return send(event, decision.category, buildNewsAlert(event, await newsImage(event)), true);
      const named = event.kind === 'token_migrated' ? await withName(event) : event;
      await send(named, decision.category, await withCard(buildTokenAlert(named), tokenCard(named)), true);
    },
    async system(text, ok) {
      const target = queues.get('SYSTEM');
      (ok ? logger.info : logger.warn)('SYSTEM', { text });
      if (!target) return;
      const outcome = await target.queue.send(buildSystemAlert(text, ok));
      if (outcome.status !== 'sent') logger.error('system alert not delivered', { error: outcome.error });
    },
    dryRunCategories() {
      return ALERT_CATEGORIES.filter((category) => !queues.has(category));
    },
    post(category, payload) {
      return deliver(category, payload, null);
    },
    gem(category, payload, editMessageId) {
      return deliver(category, payload, editMessageId);
    },
  };

  /** Sends (or edits) a ready-made payload in a category's room; null when it has no webhook. */
  async function deliver(category: AlertCategory, payload: DiscordPayload, editMessageId: string | null): Promise<SendOutcome | null> {
    const target = queues.get(category);
    if (!target) {
      logger.info('ALERT (dry run: no webhook)', { category, title: payload.embeds[0]?.title ?? '' });
      return null;
    }
    const outcome = editMessageId ? await target.queue.edit(editMessageId, payload) : await target.queue.send(payload);
    if (outcome.status === 'sent') logger.info(editMessageId ? 'ALERT edited' : 'ALERT sent', { category, title: payload.embeds[0]?.title ?? '' });
    else logger.error('ALERT not delivered', { category, status: outcome.status, error: outcome.error });
    return outcome;
  }
}

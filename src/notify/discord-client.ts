import { errorMessage, type Logger } from '../core/logger.ts';
import { backoffDelay, sleep, snowflakeToMs } from '../core/util.ts';

export interface EmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface Embed {
  /** Small line above the title: alert type and chain. */
  readonly author?: { readonly name: string; readonly url?: string };
  readonly title: string;
  readonly description?: string;
  readonly color: number;
  readonly fields: readonly EmbedField[];
  readonly timestamp?: string;
  readonly footer?: { readonly text: string };
  readonly url?: string;
  /** Large picture shown inside the embed (Discord fetches the URL). */
  readonly image?: { readonly url: string };
  readonly thumbnail?: { readonly url: string };
}

/** A file uploaded with the message; an embed shows it with `attachment://<name>`. */
export interface DiscordFile {
  readonly name: string;
  readonly data: Uint8Array;
  readonly contentType: string;
}

export interface DiscordPayload {
  readonly content?: string;
  readonly embeds: readonly Embed[];
  readonly files?: readonly DiscordFile[];
}

/** JSON body, or multipart (payload_json + files[n]) when the payload carries files. */
export function requestBody(payload: DiscordPayload): { body: string | FormData; headers: Record<string, string> } {
  const { files, ...message } = payload;
  const json = { ...message, allowed_mentions: { parse: [] } };
  if (!files || files.length === 0) return { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } };
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...json, attachments: files.map((f, id) => ({ id, filename: f.name })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([Uint8Array.from(f.data)], { type: f.contentType }), f.name));
  // No content-type header: fetch sets the multipart boundary itself.
  return { body: form, headers: {} };
}

export type SendOutcome =
  | { readonly status: 'sent'; readonly discordAt: number | null; readonly messageId?: string | null }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'dropped'; readonly error: string };

const REQUEST_TIMEOUT_MS = 10_000;
/** Network / 5xx failures before giving up on one message. */
const MAX_FAILURES = 5;
/** Rate-limit (429) waits before giving up on one message. */
const MAX_RATE_LIMIT_WAITS = 10;
/** Upper bound for any single wait, so a bogus header cannot freeze the queue. */
const MAX_WAIT_MS = 60_000;

type FetchFn = typeof fetch;

/**
 * One Discord webhook with its own sequential queue, so Discord's per-webhook rate limit
 * is respected without blocking other alert categories. The webhook URL is a secret and
 * is never logged.
 */
export class WebhookQueue {
  private readonly url: string;
  private readonly logger: Logger;
  private readonly maxPending: number;
  private readonly fetchFn: FetchFn;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private pauseUntil = 0;

  constructor(url: string, logger: Logger, maxPending: number, fetchFn: FetchFn = fetch) {
    this.url = url;
    this.logger = logger;
    this.maxPending = maxPending;
    this.fetchFn = fetchFn;
  }

  send(payload: DiscordPayload): Promise<SendOutcome> {
    return this.enqueue(payload, null);
  }

  /** Replaces a message this webhook sent earlier (PATCH /messages/{id}); same queue and rate limit. */
  edit(messageId: string, payload: DiscordPayload): Promise<SendOutcome> {
    if (!/^\d{5,25}$/.test(messageId)) return Promise.resolve({ status: 'failed', error: 'invalid message id' });
    return this.enqueue(payload, messageId);
  }

  private enqueue(payload: DiscordPayload, messageId: string | null): Promise<SendOutcome> {
    if (this.pending >= this.maxPending) {
      return Promise.resolve({ status: 'dropped', error: `queue full (${this.maxPending})` });
    }
    this.pending += 1;
    const result = this.tail.then(() => this.deliver(payload, messageId)).finally(() => { this.pending -= 1; });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async deliver(payload: DiscordPayload, messageId: string | null): Promise<SendOutcome> {
    let failures = 0;
    let rateLimitWaits = 0;
    let lastError = 'unknown';
    while (failures < MAX_FAILURES && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
      const wait = Math.min(this.pauseUntil - Date.now(), MAX_WAIT_MS);
      if (wait > 0) await sleep(wait);
      try {
        const step = await this.post(payload, messageId);
        if (step.done) return step.outcome;
        lastError = step.error;
        if (step.retryAfterMs !== undefined) {
          rateLimitWaits += 1;
          await sleep(Math.min(step.retryAfterMs, MAX_WAIT_MS));
        } else {
          await sleep(backoffDelay(failures, 1_000, 15_000));
          failures += 1;
        }
      } catch (error: unknown) {
        // A timeout here may mean Discord received the message; a retry can then duplicate it.
        lastError = errorMessage(error);
        await sleep(backoffDelay(failures, 1_000, 15_000));
        failures += 1;
      }
    }
    return { status: 'failed', error: lastError };
  }

  private async post(payload: DiscordPayload, messageId: string | null): Promise<
    | { readonly done: true; readonly outcome: SendOutcome }
    | { readonly done: false; readonly error: string; readonly retryAfterMs?: number }
  > {
    const { body, headers } = requestBody(payload);
    const target = messageId ? `${this.url}/messages/${messageId}` : `${this.url}?wait=true`;
    const response = await this.fetchFn(target, {
      method: messageId ? 'PATCH' : 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.applyRateLimitHeaders(response.headers);
    if (response.ok) {
      const json = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof json?.id === 'string' ? json.id : null;
      return { done: true, outcome: { status: 'sent', discordAt: id && !messageId ? snowflakeToMs(id) : null, messageId: id } };
    }
    if (response.status === 429) {
      const json = (await response.json().catch(() => null)) as { retry_after?: unknown } | null;
      const seconds = typeof json?.retry_after === 'number' ? json.retry_after : 2;
      this.logger.warn('discord rate limited', { retryAfterSec: seconds });
      return { done: false, error: 'HTTP 429', retryAfterMs: Math.ceil(seconds * 1000) };
    }
    if (response.status >= 500) return { done: false, error: `HTTP ${response.status}` };
    const text = (await response.text().catch(() => '')).slice(0, 200);
    return { done: true, outcome: { status: 'failed', error: `HTTP ${response.status} ${text}` } };
  }

  private applyRateLimitHeaders(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const resetAfter = Number(headers.get('x-ratelimit-reset-after'));
    if (remaining === '0' && Number.isFinite(resetAfter) && resetAfter > 0) {
      this.pauseUntil = Date.now() + Math.min(Math.ceil(resetAfter * 1000), MAX_WAIT_MS);
    }
  }
}

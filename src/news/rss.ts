import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  readonly title: string;
  readonly link: string;
  /** ms since epoch; null when the feed gives no parsable date. */
  readonly published: number | null;
  readonly summary: string;
  readonly image: string | null;
  readonly author: string | null;
}

const MAX_SUMMARY = 600;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true });

type Node = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in value) return text((value as Node)['#text']);
  return '';
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Longest field text processed; feed text is untrusted and regexes must stay cheap. */
const MAX_FIELD_CHARS = 20_000;
const MAX_URL_CHARS = 2_000;

function decodeEntity(whole: string, code: string): string {
  const hex = code.startsWith('#x') || code.startsWith('#X');
  if (hex || code.startsWith('#')) {
    const point = hex ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  }
  return ENTITIES[code.toLowerCase()] ?? whole;
}

/** Plain text from an HTML fragment: tags removed, common entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .slice(0, MAX_FIELD_CHARS)
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/&(#\d{1,8}|#x[\da-f]{1,8}|[a-z]{1,10});/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A URL safe to put in a Discord embed and a markdown link: https only, parsable, bounded,
 * with parentheses and spaces percent-encoded so feed text cannot break out of the link.
 */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    const encoded = url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
    return encoded.length <= MAX_URL_CHARS ? encoded : null;
  } catch {
    return null;
  }
}

function httpsUrl(value: unknown): string | null {
  return safeUrl(text(value));
}

function imageOf(item: Node): string | null {
  const candidates = [
    ...asArray(item['media:content']).map((m) => (m as Node)['@_url']),
    ...asArray(item['media:thumbnail']).map((m) => (m as Node)['@_url']),
    ...asArray(item.enclosure).filter((e) => String((e as Node)['@_type'] ?? '').startsWith('image')).map((e) => (e as Node)['@_url']),
  ];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    if (url) return url;
  }
  return null;
}

function atomLink(entry: Node): string {
  const links = asArray(entry.link) as Node[];
  const alternate = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alternate ? text(alternate['@_href'] ?? alternate) : '';
}

function toItem(raw: Node, atom: boolean): FeedItem | null {
  const title = htmlToText(text(raw.title));
  const link = safeUrl(atom ? atomLink(raw) : text(raw.link));
  if (!title || !link) return null;
  const dateText = text(raw.pubDate ?? raw.published ?? raw.updated ?? raw['dc:date']);
  const published = Date.parse(dateText);
  const summary = htmlToText(text(raw.description ?? raw.summary ?? raw.content ?? raw['content:encoded']));
  const author = htmlToText(text(raw['dc:creator'] ?? (raw.author as Node | undefined)?.name ?? raw.author)) || null;
  return {
    title,
    link,
    published: Number.isFinite(published) ? published : null,
    summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary,
    image: imageOf(raw),
    author,
  };
}

/** One bad entry must never cost the rest of the feed. */
function safeItem(raw: unknown, atom: boolean): FeedItem[] {
  try {
    const item = toItem(raw as Node, atom);
    return item ? [item] : [];
  } catch {
    return [];
  }
}

/** Parses RSS 2.0 or Atom XML into items. Malformed entries are skipped, never thrown. */
export function parseFeed(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Node;
  const rss = (doc.rss as Node | undefined)?.channel as Node | undefined;
  if (rss) return asArray(rss.item).flatMap((i) => safeItem(i, false));
  const atom = doc.feed as Node | undefined;
  if (atom) return asArray(atom.entry).flatMap((e) => safeItem(e, true));
  return [];
}

/** Reads at most maxBytes of a response body (feeds and pages are untrusted). */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

export interface FeedFetchState {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type FeedFetchResult =
  | { readonly status: 'ok'; readonly items: FeedItem[]; readonly state: FeedFetchState }
  | { readonly status: 'not-modified' }
  | { readonly status: 'error'; readonly error: string };

const USER_AGENT = 'MemeCoinRadar/0.1 (personal news monitor)';
const TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 3_000_000;

/** Fetches a feed politely (conditional GET with ETag / Last-Modified). Never throws. */
export async function fetchFeed(url: string, state: FeedFetchState, fetchFn: typeof fetch = fetch): Promise<FeedFetchResult> {
  try {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
    if (state.etag) headers['if-none-match'] = state.etag;
    if (state.lastModified) headers['if-modified-since'] = state.lastModified;
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 304) return { status: 'not-modified' };
    if (!response.ok) return { status: 'error', error: `HTTP ${response.status}` };
    const items = parseFeed(await readCapped(response, MAX_FEED_BYTES));
    return { status: 'ok', items, state: { etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') } };
  } catch (error: unknown) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

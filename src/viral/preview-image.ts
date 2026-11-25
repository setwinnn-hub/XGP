import { readCapped } from '../news/rss.ts';

const TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 600_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; ViralWorldRadar/1.0; link preview)';

/** YouTube video id from watch, youtu.be or shorts URLs; null otherwise. */
export function youtubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([\w-]{11})/);
  return match?.[1] ?? null;
}

/** YouTube's official thumbnail for a video URL. */
export function youtubeThumbnail(url: string): string | null {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/gi, '/');
}

/**
 * The preview image a page declares for link previews (og:image, then twitter:image).
 * This is the picture Discord itself would show when the link is pasted.
 */
export function extractPreviewImage(html: string, pageUrl: string): string | null {
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i,
    /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const raw = html.match(pattern)?.[1];
    if (!raw) continue;
    try {
      const absolute = new URL(decodeEntities(raw.trim()), pageUrl);
      if (absolute.protocol === 'https:') return absolute.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Only public https hosts: links come from untrusted feeds, so never let one make the bot
 * request localhost, private networks or cloud metadata addresses.
 */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
    return true;
  } catch {
    return false;
  }
}

/** Fetches a page and returns its preview image, or null if unavailable. Never throws. */
export async function fetchPreviewImage(pageUrl: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!isPublicHttpsUrl(pageUrl)) return null;
  try {
    const response = await fetchFn(pageUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || !isPublicHttpsUrl(response.url || pageUrl)) return null;
    if (!(response.headers.get('content-type') ?? '').includes('html')) return null;
    const html = await readCapped(response, MAX_HTML_BYTES);
    return extractPreviewImage(html, response.url || pageUrl);
  } catch {
    return null;
  }
}

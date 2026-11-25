/**
 * Alert card: the user's background picture with the alert drawn into its two frames
 * (big frame left: token, contract, stats; small frame right: the one number that matters).
 * Built as SVG so it can be rendered to an image and previewed in a browser alike.
 */

export type CardAccent = 'green' | 'red' | 'gold' | 'blue';

export interface CardStat {
  readonly label: string;
  readonly value: string;
}

export interface CardData {
  /** Small line on top, e.g. "NEW TOKEN · SOLANA". */
  readonly badge: string;
  readonly accent: CardAccent;
  /** Big title, e.g. "$Cousin". */
  readonly title: string;
  /** Next to the title, e.g. the token name. */
  readonly subtitle?: string;
  readonly address?: string;
  /** Up to 3 numbers under the address. */
  readonly stats: readonly CardStat[];
  readonly side: { readonly top: string; readonly big: string; readonly bottom: string };
}

/** Card size: the 640x361 background drawn at 2x for sharp text. */
export const CARD_W = 1280;
export const CARD_H = 722;

/** Inner areas of the two frames in the background picture (2x coordinates). */
const LEFT = { x: 24, y: 266, w: 928, h: 334 };
const RIGHT = { x: 974, y: 274, w: 290, h: 326 };
const PAD = 36;

const COLORS: Readonly<Record<CardAccent, string>> = { green: '#4ade80', red: '#f87171', gold: '#fbbf24', blue: '#60a5fa' };
const FONT = "'Leelawadee UI', 'Segoe UI', Tahoma, sans-serif";
const MONO = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

/** XML-escapes text; token names come from anyone who launches a token. */
export function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

/** Cuts text to `max` visible characters (grapheme-aware enough for names and Thai). */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function text(x: number, y: number, size: number, fill: string, content: string, opts: { weight?: number; anchor?: string; font?: string } = {}): string {
  return `<text x="${x}" y="${y}" font-family="${opts.font ?? FONT}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${fill}"${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}>${xml(content)}</text>`;
}

function leftFrame(d: CardData, accent: string): string {
  const x = LEFT.x + PAD;
  const parts = [
    text(x, LEFT.y + 64, 30, accent, clip(d.badge, 42), { weight: 700 }),
    `<text x="${x}" y="${LEFT.y + 128}" font-family="${FONT}">`
      + `<tspan font-size="56" font-weight="700" fill="#ffffff">${xml(clip(d.title, 18))}</tspan>`
      + (d.subtitle ? `<tspan font-size="32" fill="#cbd5e1" dx="16">${xml(clip(d.subtitle, 30))}</tspan>` : '')
      + '</text>',
  ];
  if (d.address) {
    parts.push(
      `<rect x="${x - 8}" y="${LEFT.y + 152}" width="${LEFT.w - 2 * PAD + 16}" height="58" rx="10" fill="#000000" fill-opacity="0.6" stroke="${accent}" stroke-opacity="0.5"/>`,
      text(x + 10, LEFT.y + 192, d.address.length > 50 ? 24 : 29, '#d9f99d', d.address, { font: MONO }),
    );
  }
  const colW = (LEFT.w - 2 * PAD) / 3;
  d.stats.slice(0, 3).forEach((s, i) => {
    const sx = x + i * colW;
    parts.push(text(sx, LEFT.y + 260, 28, '#a5b4c4', clip(s.label, 16)), text(sx, LEFT.y + 306, 44, '#ffffff', clip(s.value, 12), { weight: 700 }));
  });
  return parts.join('');
}

function rightFrame(d: CardData, accent: string): string {
  const cx = RIGHT.x + RIGHT.w / 2;
  const big = clip(d.side.big, 7);
  const size = big.length <= 3 ? 100 : big.length <= 5 ? 76 : 58;
  return [
    `<rect x="${RIGHT.x + 30}" y="${RIGHT.y + 78}" width="${RIGHT.w - 60}" height="46" rx="23" fill="#000000" fill-opacity="0.7"/>`,
    text(cx, RIGHT.y + 111, 28, '#ffffff', clip(d.side.top, 14), { weight: 700, anchor: 'middle' }),
    text(cx, RIGHT.y + 225, size, accent, big, { weight: 700, anchor: 'middle' }),
    text(cx, RIGHT.y + 286, 26, '#e2e8f0', clip(d.side.bottom, 16), { anchor: 'middle' }),
  ].join('');
}

/**
 * SVG for one card. With `background` (a data: URI) it is self-contained, for browser previews;
 * without it, it is a transparent overlay that the renderer puts on top of the picture.
 * Layout is designed on a 1280x722 grid; `outWidth` scales it (vector text stays sharp).
 */
export function buildCardSvg(d: CardData, background: string | null = null, outWidth: number = CARD_W): string {
  const accent = COLORS[d.accent];
  const outHeight = Math.round((outWidth * CARD_H) / CARD_W);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${CARD_W} ${CARD_H}">`
    + (background ? `<image href="${xml(background)}" xlink:href="${xml(background)}" x="0" y="0" width="${CARD_W}" height="${CARD_H}" preserveAspectRatio="none"/>` : '')
    + `<rect x="${LEFT.x + 6}" y="${LEFT.y + 6}" width="${LEFT.w - 12}" height="${LEFT.h - 12}" rx="22" fill="#020617" fill-opacity="0.55"/>`
    + `<rect x="${RIGHT.x + 6}" y="${RIGHT.y + 6}" width="${RIGHT.w - 12}" height="${RIGHT.h - 12}" rx="22" fill="#020617" fill-opacity="0.55"/>`
    + leftFrame(d, accent)
    + rightFrame(d, accent)
    + '</svg>';
}

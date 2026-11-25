import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { buildCardSvg, CARD_H, CARD_W, type CardData } from './card.ts';

/** Default background location (kept out of git: it is the user's own picture). */
export const DEFAULT_CARD_BG = 'assets/card-bg.webp';
/** High enough that text edges stay clean; a 1536-wide card is still ~250 KB. */
const JPEG_QUALITY = 90;
/** Cards are drawn at the picture's own width (never upscaled), within these bounds. */
const MIN_WIDTH = CARD_W;
const MAX_WIDTH = 1920;

export type CardRenderer = (card: CardData) => Promise<Buffer>;

/**
 * Renders cards onto the background picture at its own resolution, so a larger picture gives a
 * sharper card. Returns null when the picture is missing, so alerts go out without a card.
 */
export async function createCardRenderer(backgroundPath: string = DEFAULT_CARD_BG): Promise<CardRenderer | null> {
  if (!existsSync(backgroundPath)) return null;
  const meta = await sharp(backgroundPath).metadata();
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, meta.width ?? CARD_W));
  const height = Math.round((width * CARD_H) / CARD_W);
  // Resized once; every card only composites its vector overlay on top.
  const background = await sharp(backgroundPath).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  return (card) => sharp(background)
    .composite([{ input: Buffer.from(buildCardSvg(card, null, width)), top: 0, left: 0 }])
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

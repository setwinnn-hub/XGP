import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { buildCardSvg, CARD_H, CARD_W, type CardData } from './card.ts';

/** Default background location (kept out of git: it is the user's own picture). */
export const DEFAULT_CARD_BG = 'assets/card-bg.webp';
/** JPEG keeps a card around 100 KB; PNG of the same picture is several times larger. */
const JPEG_QUALITY = 82;

export type CardRenderer = (card: CardData) => Promise<Buffer>;

/**
 * Renders cards onto the background picture. Returns null when the picture is missing, so
 * alerts simply go out without a card.
 */
export async function createCardRenderer(backgroundPath: string = DEFAULT_CARD_BG): Promise<CardRenderer | null> {
  if (!existsSync(backgroundPath)) return null;
  // Resized once; every card only composites its text overlay on top.
  const background = await sharp(backgroundPath).resize(CARD_W, CARD_H, { fit: 'fill' }).png().toBuffer();
  return (card) => sharp(background)
    .composite([{ input: Buffer.from(buildCardSvg(card)), top: 0, left: 0 }])
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

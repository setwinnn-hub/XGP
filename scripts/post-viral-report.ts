/**
 * Posts a Viral World Radar report (JSON) to DISCORD_WEBHOOK_VIRAL: a short header, then
 * ONE message per story, ranked by score. Each story shows its picture and full text in
 * Discord, and a YouTube clip link is put in the message so Discord plays it inline.
 *
 * Usage: npm run viral:post -- docs/viral/<report.json> [--dry]
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { createLogger, errorMessage } from '../src/core/logger.ts';
import { WebhookQueue, type DiscordPayload, type Embed, type EmbedField } from '../src/notify/discord-client.ts';
import { sanitize } from '../src/notify/format.ts';
import { fetchPreviewImage, youtubeId, youtubeThumbnail } from '../src/viral/preview-image.ts';

interface Story {
  readonly title: string;
  readonly category: string;
  readonly what: string;
  readonly why: string;
  readonly country: string;
  readonly published: string;
  readonly engagement: string | null;
  readonly score: number;
  readonly source: string;
  readonly media: string | null;
  readonly note: string | null;
  /**
   * Optional explicit picture; otherwise taken from the clip or the source page.
   * "none" suppresses the picture (e.g. when the page's preview image is unrelated).
   */
  readonly image?: string | null;
}

interface Report {
  readonly title: string;
  readonly checkedAt: string;
  readonly note: string;
  readonly stories: readonly Story[];
}

function scoreColor(score: number): number {
  if (score >= 80) return 0xef4444;
  if (score >= 65) return 0xf97316;
  if (score >= 55) return 0xeab308;
  return 0x64748b;
}

function isHttpsUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value);
}

/** Picture for a story: explicit image, YouTube thumbnail, source page preview, clip page preview. */
async function resolveImage(story: Story): Promise<string | null> {
  if (story.image === 'none') return null;
  if (isHttpsUrl(story.image)) return story.image;
  const fromYoutube = isHttpsUrl(story.media) ? youtubeThumbnail(story.media) : null;
  if (fromYoutube) return fromYoutube;
  const fromSource = await fetchPreviewImage(story.source);
  if (fromSource) return fromSource;
  return isHttpsUrl(story.media) ? fetchPreviewImage(story.media) : null;
}

function storyPayload(story: Story, rank: number, image: string | null): DiscordPayload {
  const fields: EmbedField[] = [
    { name: '🏷️ ประเภท', value: sanitize(story.category, 60) || '-', inline: true },
    { name: '🌍 ประเทศ', value: sanitize(story.country, 60) || '-', inline: true },
    { name: '🔥 คะแนนความไวรัล', value: `**${story.score}**/100`, inline: true },
    { name: '📅 วันที่เผยแพร่', value: sanitize(story.published, 80) || '-', inline: true },
    { name: '📊 Engagement', value: story.engagement ? sanitize(story.engagement, 200) : 'แหล่งข่าวไม่ระบุ', inline: true },
    ...(story.note ? [{ name: '⚠️ หมายเหตุ', value: sanitize(story.note, 200) || '-', inline: false }] : []),
    { name: '📰 อ้างอิง', value: [`[แหล่งข่าว](${story.source})`, ...(isHttpsUrl(story.media) ? [`[โพสต์ต้นฉบับ](${story.media})`] : [])].join('  •  '), inline: false },
  ];
  const embed: Embed = {
    title: `#${rank}  ${sanitize(story.title, 200)}`,
    url: story.source,
    description: [`**🎬 เกิดอะไรขึ้น**`, sanitize(story.what, 900), '', `**💡 ทำไมถึงเป็นไวรัล**`, sanitize(story.why, 600)].join('\n'),
    color: scoreColor(story.score),
    fields,
    ...(image ? { image: { url: image } } : {}),
  };
  // A YouTube link in the message body makes Discord show a playable video under the card.
  const playable = isHttpsUrl(story.media) && youtubeId(story.media) ? story.media : undefined;
  return playable ? { content: `▶️ ดูคลิป: ${playable}`, embeds: [embed] } : { embeds: [embed] };
}

function headerPayload(report: Report, count: number): DiscordPayload {
  const unix = Math.floor(Date.parse(report.checkedAt) / 1000);
  return {
    embeds: [{
      title: `🌍 ${sanitize(report.title, 200)}`,
      description: `${count} เรื่อง ส่งทีละเรื่อง เรียงจากโอกาสเป็นกระแสมากที่สุด\nตรวจสอบเมื่อ <t:${unix}:f>\n\n${sanitize(report.note, 500)}`,
      color: 0x8b5cf6,
      fields: [],
    }],
  };
}

function load(path: string): Report {
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
  for (const story of report.stories) {
    if (!isHttpsUrl(story.source)) throw new Error(`Story "${story.title}" has no valid https source link`);
  }
  return report;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run viral:post -- <report.json> [--dry]');
  const dry = process.argv.includes('--dry');
  const report = load(path);
  const ranked = [...report.stories].sort((a, b) => b.score - a.score);
  const images = await Promise.all(ranked.map(resolveImage));
  if (dry) {
    ranked.forEach((story, i) => process.stdout.write(`#${i + 1} image=${images[i] ?? 'none'}\n`));
    return;
  }
  const url = loadConfig().webhooks.VIRAL;
  if (!url) throw new Error('DISCORD_WEBHOOK_VIRAL is not set in .env');
  const queue = new WebhookQueue(url, createLogger('warn', null), 50);

  const header = await queue.send(headerPayload(report, ranked.length));
  if (header.status !== 'sent') throw new Error(`header not delivered: ${header.status}`);
  for (const [i, story] of ranked.entries()) {
    const outcome = await queue.send(storyPayload(story, i + 1, images[i] ?? null));
    const detail = outcome.status === 'sent' ? (images[i] ? 'with image' : 'no image found') : `${outcome.status} ${outcome.error}`;
    process.stdout.write(`#${i + 1} ${outcome.status} (${detail})\n`);
  }
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}

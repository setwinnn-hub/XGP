import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPreviewImage, fetchPreviewImage, youtubeId, youtubeThumbnail } from '../src/viral/preview-image.ts';

describe('youtube helpers', () => {
  it('reads ids from shorts, watch and youtu.be links', () => {
    assert.equal(youtubeId('https://www.youtube.com/shorts/Nvf4xuHxN4o'), 'Nvf4xuHxN4o');
    assert.equal(youtubeId('https://www.youtube.com/watch?v=Nvf4xuHxN4o&t=3'), 'Nvf4xuHxN4o');
    assert.equal(youtubeId('https://youtu.be/Nvf4xuHxN4o'), 'Nvf4xuHxN4o');
    assert.equal(youtubeId('https://www.tiktok.com/@a/video/1'), null);
    assert.equal(youtubeThumbnail('https://www.youtube.com/shorts/Nvf4xuHxN4o'), 'https://i.ytimg.com/vi/Nvf4xuHxN4o/hqdefault.jpg');
  });
});

describe('extractPreviewImage', () => {
  it('finds og:image in either attribute order and resolves relative URLs', () => {
    assert.equal(extractPreviewImage('<meta property="og:image" content="https://cdn.x/a.jpg">', 'https://x.com/p'), 'https://cdn.x/a.jpg');
    assert.equal(extractPreviewImage('<meta content="/img/b.png" property="og:image" />', 'https://news.example/story'), 'https://news.example/img/b.png');
    assert.equal(extractPreviewImage('<meta name="twitter:image" content="https://c.example/t.jpg">', 'https://x'), 'https://c.example/t.jpg');
  });

  it('decodes entities and rejects non-https images', () => {
    assert.equal(extractPreviewImage('<meta property="og:image" content="https://a.b/i.jpg?x=1&amp;y=2">', 'https://a.b'), 'https://a.b/i.jpg?x=1&y=2');
    assert.equal(extractPreviewImage('<meta property="og:image" content="http://a.b/i.jpg">', 'https://a.b'), null);
    assert.equal(extractPreviewImage('<html></html>', 'https://a.b'), null);
  });

  it('returns null instead of throwing when the page cannot be read', async () => {
    const failing = (async () => { throw new Error('network'); }) as typeof fetch;
    assert.equal(await fetchPreviewImage('https://a.b', failing), null);
  });
});

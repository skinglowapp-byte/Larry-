// api/upload-slides.js
// Uploads base64 slide images to Vercel Blob and returns serve URLs.
// Called by addToQueue() in index.html before saving jobs to Redis.
//
// WHY THIS EXISTS:
// Redis has a 1MB per-value limit. A 6-slide slideshow as base64 is ~2-3MB,
// which silently fails to save. By uploading to Blob first and storing only
// URLs in Redis, each job is ~1KB instead of ~3MB.
//
// The Blob files get a 24hr TTL — long enough for the scheduler to post them,
// but they won't accumulate forever. api/cleanup.js handles deletion after posting.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set' });

  const { images } = req.body;
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'images array required' });
  }

  const urls = [];
  const fileIds = [];

  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      let buffer;

      if (typeof image === 'string' && image.startsWith('data:')) {
        const base64 = image.replace(/^data:image\/\w+;base64,/, '');
        buffer = Buffer.from(base64, 'base64');
      } else if (typeof image === 'string' && image.startsWith('http')) {
        // Already a URL (e.g. from a previous upload) — just pass through
        urls.push(image);
        continue;
      } else {
        return res.status(400).json({ error: `Invalid image format at index ${i}` });
      }

      const fileId  = `queue-${Date.now()}-${i}`;
      const filename = `slides/${fileId}.jpg`;

      const uploadRes = await fetch(`https://blob.vercel-storage.com/${filename}`, {
        method: 'PUT',
        headers: {
          'Authorization':           `Bearer ${blobToken}`,
          'Content-Type':            'image/jpeg',
          'x-api-version':           '7',
          // 24hr TTL — plenty of time for the scheduler to post
          'x-cache-control-max-age': '86400',
        },
        body: buffer,
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Blob upload failed for slide ${i + 1}: ${uploadRes.status} ${text}`);
      }

      const serveUrl = `https://larry-slidshow.vercel.app/api/serve?id=${fileId}.jpg`;
      urls.push(serveUrl);
      fileIds.push(fileId);
    }

    // Register uploaded blobs for cleanup after posting
    // (reuses the same cleanup queue as cron.js)
    if (fileIds.length > 0) {
      try {
        const { kvRPush } = await import('../lib/kv.js');
        await kvRPush(
          'larry:blob:cleanup',
          ...fileIds.map(id => ({ id, scheduledAt: Date.now() + 23 * 60 * 60 * 1000 })) // cleanup after 23hrs
        );
      } catch (e) {
        console.warn('[upload-slides] cleanup registration failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true, urls, count: urls.length });

  } catch (e) {
    console.error('[upload-slides] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

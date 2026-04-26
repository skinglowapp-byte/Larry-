// api/upload-slides.js
// Uploads base64 data (images OR audio) to Vercel Blob and returns serve URLs.
//
// BACKWARDS COMPATIBLE: existing slideshow flow still uses { images: [...] }
//                       with image data URLs and gets serve URLs back.
// NEW: audio data URLs (data:audio/mpeg;base64,...) auto-routed to /audio/
//      folder and returned as direct blob URLs (which FAL sync-lipsync needs).
//
// WHY THIS EXISTS:
// Redis has a 1MB per-value limit. A 6-slide slideshow as base64 is ~2-3MB,
// which silently fails to save. By uploading to Blob first and storing only
// URLs in Redis, each job is ~1KB instead of ~3MB.

export const config = { maxDuration: 60 };

// Map data URL mime types → file ext + folder
const MIME_MAP = {
  'image/jpeg': { ext: 'jpg', folder: 'slides' },
  'image/jpg':  { ext: 'jpg', folder: 'slides' },
  'image/png':  { ext: 'png', folder: 'slides' },
  'image/webp': { ext: 'webp', folder: 'slides' },
  'audio/mpeg': { ext: 'mp3', folder: 'audio' },
  'audio/mp3':  { ext: 'mp3', folder: 'audio' },
  'audio/wav':  { ext: 'wav', folder: 'audio' },
  'audio/ogg':  { ext: 'ogg', folder: 'audio' },
  'video/mp4':  { ext: 'mp4', folder: 'video' },
};

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const meta = MIME_MAP[mime] || { ext: 'bin', folder: 'misc' };
  return { mime, base64: m[2], ...meta };
}

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
      const item = images[i];

      // Already a URL — pass through
      if (typeof item === 'string' && item.startsWith('http')) {
        urls.push(item);
        continue;
      }

      // Must be a data URL
      if (typeof item !== 'string' || !item.startsWith('data:')) {
        return res.status(400).json({ error: `Invalid format at index ${i}` });
      }

      const parsed = parseDataUrl(item);
      if (!parsed) {
        return res.status(400).json({ error: `Invalid data URL at index ${i}` });
      }

      const buffer   = Buffer.from(parsed.base64, 'base64');
      const fileId   = `queue-${Date.now()}-${i}`;
      const filename = `${parsed.folder}/${fileId}.${parsed.ext}`;

      const uploadRes = await fetch(`https://blob.vercel-storage.com/${filename}`, {
        method: 'PUT',
        headers: {
          'Authorization':           `Bearer ${blobToken}`,
          'Content-Type':            parsed.mime,
          'x-api-version':           '7',
          // 24hr TTL — plenty of time for the scheduler to post
          'x-cache-control-max-age': '86400',
        },
        body: buffer,
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Blob upload failed for item ${i + 1}: ${uploadRes.status} ${text}`);
      }

      // For images (slides) → use /api/serve proxy on verified domain (TikTok requires this)
      // For audio/video → use direct blob URL (FAL accepts any public URL)
      let serveUrl;
      if (parsed.folder === 'slides') {
        serveUrl = `https://larry-slidshow.vercel.app/api/serve?id=${fileId}.${parsed.ext}`;
      } else {
        // Look up the actual public blob URL
        const listRes = await fetch(
          `https://blob.vercel-storage.com?prefix=${encodeURIComponent(filename)}`,
          { headers: { 'Authorization': `Bearer ${blobToken}`, 'x-api-version': '7' } }
        );
        const listData = await listRes.json();
        serveUrl = listData?.blobs?.[0]?.url;
        if (!serveUrl) throw new Error(`Could not resolve blob URL for ${filename}`);
      }

      urls.push(serveUrl);
      fileIds.push(fileId);
    }

    // Register uploaded blobs for cleanup after posting
    if (fileIds.length > 0) {
      try {
        const { kvRPush } = await import('../lib/kv.js');
        await kvRPush(
          'larry:blob:cleanup',
          ...fileIds.map(id => ({ id, scheduledAt: Date.now() + 23 * 60 * 60 * 1000 }))
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

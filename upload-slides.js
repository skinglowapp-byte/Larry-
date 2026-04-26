// /api/upload-slides.js
// Uploads base64 data URLs (images or audio) to Vercel Blob.
// Returns public URLs that can be passed to TikTok PULL_FROM_URL or FAL sync-lipsync.

import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb', // allow for multiple slides + audio
    },
  },
};

// Map data URL mime types to file extensions
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
};

function parseDataUrl(dataUrl) {
  // dataUrl looks like: data:image/jpeg;base64,/9j/4AAQ...
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  const ext = MIME_TO_EXT[mime] || 'bin';
  return { mime, base64, ext };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({
      error: 'BLOB_READ_WRITE_TOKEN not configured in environment',
    });
  }

  try {
    const { slides } = req.body || {};

    if (!Array.isArray(slides) || slides.length === 0) {
      return res.status(400).json({ error: 'slides array required' });
    }

    const urls = [];
    const errors = [];

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const dataUrl = slide.dataUrl || slide.data_url || slide.data;
      const filename = slide.filename || `upload_${Date.now()}_${i}.bin`;

      if (!dataUrl) {
        errors.push({ index: i, error: 'missing dataUrl' });
        urls.push(null);
        continue;
      }

      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        errors.push({ index: i, error: 'invalid data URL format' });
        urls.push(null);
        continue;
      }

      try {
        const buffer = Buffer.from(parsed.base64, 'base64');

        // If filename has no extension, append the parsed one
        const finalFilename = /\.[a-z0-9]+$/i.test(filename)
          ? filename
          : `${filename}.${parsed.ext}`;

        const blob = await put(finalFilename, buffer, {
          access: 'public',
          contentType: parsed.mime,
          addRandomSuffix: true,
        });

        urls.push(blob.url);
      } catch (e) {
        console.error(`Upload failed for slide ${i}:`, e);
        errors.push({ index: i, error: e.message });
        urls.push(null);
      }
    }

    return res.status(200).json({
      urls,
      count: urls.filter(Boolean).length,
      total: slides.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    console.error('upload-slides error:', e);
    return res.status(500).json({
      error: e.message || 'Upload failed',
    });
  }
}

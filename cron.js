// api/cron.js
// Runs every hour via Vercel cron.
// Reads queue from KV, posts anything due, moves to posted log.

import { kvLRange, kvRPush, kvDel, kvLTrim, KEYS } from '../lib/kv.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const queue = await kvLRange(KEYS.QUEUE, 0, 99999);
  const now = Date.now();
  const windowEnd = now + 60 * 60 * 1000;

  const due = queue.filter(j => j.status === 'pending' && j.scheduledFor <= windowEnd);

  if (due.length === 0) {
    return res.status(200).json({ ok: true, message: 'Nothing due', queueLength: queue.length });
  }

  const results = [];

  for (const job of due) {
    const delay = job.scheduledFor - Date.now();
    if (delay > 0 && delay < 55000) await sleep(delay);
    else if (delay > 55000) continue;

    try {
      await postToTikTok(job);

      const remaining = queue.filter(j => j.id !== job.id);
      await kvDel(KEYS.QUEUE);
      if (remaining.length > 0) await kvRPush(KEYS.QUEUE, ...remaining);

      await kvRPush(KEYS.POSTED, { ...job, status: 'posted', postedAt: Date.now() });
      await kvLTrim(KEYS.POSTED, 0, 99);

      results.push({ id: job.id, status: 'posted', account: job.accountLabel });
    } catch (e) {
      const updated = queue.map(j => j.id === job.id ? { ...j, status: 'failed', error: e.message } : j);
      await kvDel(KEYS.QUEUE);
      if (updated.length > 0) await kvRPush(KEYS.QUEUE, ...updated);
      results.push({ id: job.id, status: 'failed', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}

async function postToTikTok(job) {
  const { accountToken, images, caption, posting_mode } = job;
  if (!accountToken) throw new Error('No TikTok token for this account');
  if (!images?.length) throw new Error('No images');

  const isLive = posting_mode === 'live';

  // Clean title
  const captionLines = caption ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean) : [];
  const titleLine = captionLines.find(l => !l.startsWith('#')) || '';
  const cleanTitle = titleLine.replace(/#\w+/g, '').replace(/[<>"]/g, '').trim().slice(0, 150) || 'Skincare story';

  // Convert base64 to buffers
  const imageBuffers = images.map(img => {
    const base64 = img.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64, 'base64');
  });

  // Init post
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accountToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({
      post_info: {
        title: cleanTitle,
        privacy_level: isLive ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        auto_add_music: true,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        photo_cover_index: 0,
        photo_count: imageBuffers.length
      },
      post_mode: isLive ? 'DIRECT_POST' : 'INBOX',
      media_type: 'PHOTO'
    })
  });

  const initData = await initRes.json();
  if (initData.error?.code && initData.error.code !== 'ok') {
    throw new Error(initData.error.message || JSON.stringify(initData.error));
  }

  const uploadUrls = initData.data?.upload_urls;
  if (!uploadUrls?.length) throw new Error('No upload URLs from TikTok');

  // Upload each image
  for (let i = 0; i < uploadUrls.length; i++) {
    const uploadRes = await fetch(uploadUrls[i], {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: imageBuffers[i]
    });
    if (!uploadRes.ok) throw new Error(`Image ${i + 1} upload failed`);
  }

  return { publish_id: initData.data?.publish_id };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

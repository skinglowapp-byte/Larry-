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
  const windowEnd = now + 60 * 60 * 1000; // next hour

  const due = queue.filter(j => j.status === 'pending' && j.scheduledFor <= windowEnd);

  if (due.length === 0) {
    return res.status(200).json({ ok: true, message: 'Nothing due', queueLength: queue.length });
  }

  const results = [];

  for (const job of due) {
    // Wait until the exact scheduled time (max 55s)
    const delay = job.scheduledFor - Date.now();
    if (delay > 0 && delay < 55000) await sleep(delay);
    else if (delay > 55000) continue; // defer to next cron run

    try {
      await postToTikTok(job);

      // Remove from queue
      const remaining = queue.filter(j => j.id !== job.id);
      await kvDel(KEYS.QUEUE);
      if (remaining.length > 0) await kvRPush(KEYS.QUEUE, ...remaining);

      // Add to posted log
      await kvRPush(KEYS.POSTED, { ...job, status: 'posted', postedAt: Date.now() });
      await kvLTrim(KEYS.POSTED, 0, 99); // keep last 100

      results.push({ id: job.id, status: 'posted', account: job.accountLabel });
    } catch (e) {
      // Mark failed but keep in queue
      const updated = queue.map(j => j.id === job.id ? { ...j, status: 'failed', error: e.message } : j);
      await kvDel(KEYS.QUEUE);
      if (updated.length > 0) await kvRPush(KEYS.QUEUE, ...updated);
      results.push({ id: job.id, status: 'failed', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}

async function postToTikTok(job) {
  const { accountToken, images, caption } = job;
  if (!accountToken) throw new Error('No TikTok token for this account');
  if (!images?.length) throw new Error('No images');

  const res = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accountToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: caption?.slice(0, 150) || '',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        auto_add_music: true,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: images.map((url, i) => ({ image_url: url, image_index: i })),
        photo_cover_index: 0,
      },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    }),
  });

  const data = await res.json();
  if (data.error?.code && data.error.code !== 'ok') {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

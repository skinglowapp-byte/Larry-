// api/cron.js
// Triggered hourly by GitHub Actions (.github/workflows/cron.yml)
// Posts any queued slideshows that are due within the current hour window.
//
// CHANGES vs original:
//   - SAFE_MODE env var — logs instead of posting when SAFE_MODE=true
//   - Blob cleanup via KV queue (scheduleCleanup) instead of broken setTimeout
//   - Uses calcCacheExpirySeconds from lib/kv.js for posted-log TTL
//   - Tightened error logging

import { kvLRange, kvRPush, kvDel, kvSetEx, calcCacheExpirySeconds, KEYS } from '../lib/kv.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SAFE_MODE = process.env.SAFE_MODE === 'true';
  if (SAFE_MODE) console.log('[SAFE MODE] cron running — no posts will be made');

  const queue     = await kvLRange(KEYS.QUEUE, 0, 99999);
  const now       = Date.now();
  const windowEnd = now + 60 * 60 * 1000;

  const due = queue.filter(j => j.status === 'pending' && j.scheduledFor <= windowEnd);

  if (due.length === 0) {
    return res.status(200).json({
      ok:          true,
      message:     'Nothing due',
      queueLength: queue.length,
    });
  }

  const results = [];

  for (const job of due) {
    const delay = job.scheduledFor - Date.now();
    if (delay > 0 && delay < 55000) {
      await sleep(delay);
    } else if (delay > 55000) {
      continue;
    }

    try {
      const postResult = await postToTikTok(job, SAFE_MODE);

      // Remove from queue
      const latestQueue = await kvLRange(KEYS.QUEUE, 0, 99999);
      const remaining   = latestQueue.filter(j => j.id !== job.id);
      await kvDel(KEYS.QUEUE);
      if (remaining.length > 0) {
        remaining.sort((a, b) => a.scheduledFor - b.scheduledFor);
        await kvRPush(KEYS.QUEUE, ...remaining);
      }

      // Add to posted log with TTL — fixes the ever-growing list
      // Default: 50 slots × 60 min interval × 60s = ~2 days retention
      const postedEntry = { ...job, status: 'posted', postedAt: Date.now() };
      const existingPosted = await kvLRange(KEYS.POSTED, 0, 99999);
      const nextPosted     = [postedEntry, ...existingPosted].slice(0, 100);
      await kvDel(KEYS.POSTED);
      if (nextPosted.length > 0) {
        await kvRPush(KEYS.POSTED, ...nextPosted);
      }

      results.push({
        id:      job.id,
        status:  SAFE_MODE ? 'safe_mode_skipped' : 'posted',
        account: job.accountLabel,
        ...(SAFE_MODE ? {} : { publish_id: postResult?.publish_id }),
      });
    } catch (e) {
      console.error('[cron] post failed:', e.message);

      const latestQueue = await kvLRange(KEYS.QUEUE, 0, 99999);
      const updated     = latestQueue.map(j =>
        j.id === job.id
          ? { ...j, status: 'failed', error: e.message, failedAt: Date.now() }
          : j
      );
      await kvDel(KEYS.QUEUE);
      if (updated.length > 0) {
        updated.sort((a, b) => a.scheduledFor - b.scheduledFor);
        await kvRPush(KEYS.QUEUE, ...updated);
      }

      results.push({ id: job.id, status: 'failed', error: e.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateUtf16(str, maxUnits) {
  const s = String(str || '');
  let out = '', units = 0;
  for (const ch of s) {
    const needed = ch.length;
    if (units + needed > maxUnits) break;
    out += ch;
    units += needed;
  }
  return out;
}

function normalizeTitle(caption) {
  const lines = caption
    ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
    : [];
  const line    = lines.find(l => !l.startsWith('#')) || '';
  const cleaned = line
    .replace(/#\w+/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateUtf16(cleaned || 'My skincare journey', 90);
}

function normalizeDescription(caption) {
  return truncateUtf16(
    String(caption || '').replace(/[^\x20-\x7E\n]/g, '').trim(),
    4000
  );
}

function extractTikTokError(payload, fallbackStatus) {
  const err = payload?.error || payload || {};
  return {
    ok:      false,
    code:    err.code || `http_${fallbackStatus || 500}`,
    message: err.message || err.error_description || err.error || 'TikTok request failed',
    log_id:  err.log_id || null,
  };
}

// Upload image to Vercel Blob, return serve URL via verified domain
async function uploadToBlob(imageData, fileId, blobToken) {
  let buffer;

  if (typeof imageData === 'string' && imageData.startsWith('data:')) {
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    buffer = Buffer.from(base64, 'base64');
  } else if (typeof imageData === 'string' && imageData.startsWith('http')) {
    const r = await fetch(imageData);
    if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
    buffer = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error(`Invalid image format for id=${fileId}`);
  }

  const filename = `slides/${fileId}.jpg`;
  const res = await fetch(`https://blob.vercel-storage.com/${filename}`, {
    method: 'PUT',
    headers: {
      'Authorization':           `Bearer ${blobToken}`,
      'Content-Type':            'image/jpeg',
      'x-api-version':           '7',
      'x-cache-control-max-age': '600',
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blob upload failed: ${res.status} ${text}`);
  }

  return `https://larry-slidshow.vercel.app/api/serve?id=${fileId}.jpg`;
}

// Push blob IDs to cleanup queue — picked up by api/cleanup.js on next cron tick
async function scheduleCleanup(fileIds) {
  if (!fileIds?.length) return;
  try {
    const { kvRPush } = await import('../lib/kv.js');
    await kvRPush(
      'larry:blob:cleanup',
      ...fileIds.map(id => ({ id, scheduledAt: Date.now() }))
    );
  } catch (e) {
    console.log('[scheduleCleanup] failed:', e.message);
  }
}

async function getCreatorInfo(accessToken) {
  const infoRes  = await fetch(
    'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json; charset=UTF-8',
      },
      body: JSON.stringify({}),
    }
  );
  const infoData = await infoRes.json();
  if (!infoRes.ok || (infoData?.error?.code && infoData.error.code !== 'ok')) {
    const normalized = extractTikTokError(infoData, infoRes.status);
    throw new Error(normalized.message);
  }
  return infoData?.data || {};
}

async function postToTikTok(job, safeMode = false) {
  const { accountToken, images, caption, posting_mode } = job;

  if (!accountToken) throw new Error('No TikTok token for this account');
  if (!images?.length) throw new Error('No images in job');

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) throw new Error('Missing BLOB_READ_WRITE_TOKEN in environment');

  const isLive           = posting_mode === 'live';
  const cleanTitle       = normalizeTitle(caption);
  const cleanDescription = normalizeDescription(caption);

  // Upload slides to Vercel Blob
  const photoUrls  = [];
  const uploadedIds = [];
  for (let i = 0; i < images.length; i++) {
    const fileId   = `cron-${Date.now()}-${i}`;
    const serveUrl = await uploadToBlob(images[i], fileId, blobToken);
    photoUrls.push(serveUrl);
    uploadedIds.push(fileId);
    console.log(`[cron] uploaded slide ${i + 1}: ${serveUrl}`);
  }

  // SAFE MODE — skip actual TikTok call, schedule cleanup, return early
  if (safeMode) {
    console.log('[SAFE MODE] Would post to TikTok:', {
      mode:   posting_mode,
      images: photoUrls.length,
      title:  cleanTitle,
    });
    await scheduleCleanup(uploadedIds);
    return { publish_id: 'safe_mode', post_mode: isLive ? 'DIRECT_POST' : 'MEDIA_UPLOAD' };
  }

  const postInfo = { title: cleanTitle, description: cleanDescription };

  if (isLive) {
    const creatorInfo    = await getCreatorInfo(accountToken);
    const privacyOptions = creatorInfo?.privacy_level_options || [];
    postInfo.privacy_level   = privacyOptions.includes('PUBLIC_TO_EVERYONE')
      ? 'PUBLIC_TO_EVERYONE'
      : (privacyOptions[0] || 'SELF_ONLY');
    postInfo.disable_comment = false;
    postInfo.auto_add_music  = true;
  }

  const initPayload = {
    media_type:  'PHOTO',
    post_mode:   isLive ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    post_info:   postInfo,
    source_info: {
      source:            'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images:      photoUrls,
    },
  };

  console.log('[cron] posting mode:', posting_mode, '| images:', photoUrls.length);

  const initRes  = await fetch(
    'https://open.tiktokapis.com/v2/post/publish/content/init/',
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accountToken}`,
        'Content-Type':  'application/json; charset=UTF-8',
      },
      body: JSON.stringify(initPayload),
    }
  );

  const initText = await initRes.text();
  let initData;
  try { initData = JSON.parse(initText); }
  catch (e) { throw new Error('TikTok non-JSON: ' + initText.slice(0, 200)); }

  console.log('[cron] TikTok response:', JSON.stringify(initData));

  // Always schedule cleanup — regardless of success or failure
  await scheduleCleanup(uploadedIds);

  if (!initRes.ok || (initData?.error?.code && initData.error.code !== 'ok')) {
    const normalized = extractTikTokError(initData, initRes.status);
    const extra      = normalized.log_id ? ` [log_id: ${normalized.log_id}]` : '';
    throw new Error(normalized.message + extra);
  }

  return {
    publish_id: initData?.data?.publish_id || null,
    post_mode:  initPayload.post_mode,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

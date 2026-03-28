// api/cron.js
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
    if (delay > 0 && delay < 55000) {
      await sleep(delay);
    } else if (delay > 55000) {
      continue;
    }

    try {
      await postToTikTok(job);

      // Reload queue fresh each iteration so we don't resurrect old jobs
      const latestQueue = await kvLRange(KEYS.QUEUE, 0, 99999);
      const remaining = latestQueue.filter(j => j.id !== job.id);

      await kvDel(KEYS.QUEUE);
      if (remaining.length > 0) {
        remaining.sort((a, b) => a.scheduledFor - b.scheduledFor);
        await kvRPush(KEYS.QUEUE, ...remaining);
      }

      // Keep newest posted items first
      const postedEntry = { ...job, status: 'posted', postedAt: Date.now() };
      const existingPosted = await kvLRange(KEYS.POSTED, 0, 99999);
      const nextPosted = [postedEntry, ...existingPosted].slice(0, 100);

      await kvDel(KEYS.POSTED);
      if (nextPosted.length > 0) {
        await kvRPush(KEYS.POSTED, ...nextPosted);
      }

      results.push({ id: job.id, status: 'posted', account: job.accountLabel });
    } catch (e) {
      console.error('[cron] post failed:', e.message);

      const latestQueue = await kvLRange(KEYS.QUEUE, 0, 99999);
      const updated = latestQueue.map(j =>
        j.id === job.id ? { ...j, status: 'failed', error: e.message, failedAt: Date.now() } : j
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

function truncateUtf16(str, maxUnits) {
  const s = String(str || '');
  let out = '';
  let units = 0;
  for (const ch of s) {
    const needed = ch.length;
    if (units + needed > maxUnits) break;
    out += ch;
    units += needed;
  }
  return out;
}

function normalizeTitle(caption) {
  const captionLines = caption
    ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean)
    : [];
  const titleLine = captionLines.find(l => !l.startsWith('#')) || '';
  const cleaned = titleLine
    .replace(/#\w+/g, '')
    .replace(/[<>\"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateUtf16(cleaned || 'My skincare journey', 90);
}

function normalizeDescription(caption) {
  return truncateUtf16(String(caption || '').trim(), 4000);
}

function extractTikTokError(payload, fallbackStatus) {
  const err = payload?.error || payload || {};
  return {
    ok: false,
    code: err.code || `http_${fallbackStatus || 500}`,
    message: err.message || err.error_description || err.error || 'TikTok request failed',
    log_id: err.log_id || null,
    detail: payload || null,
  };
}

async function getCreatorInfo(accessToken) {
  const infoRes = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({}),
  });

  const infoData = await infoRes.json();

  if (!infoRes.ok || (infoData?.error?.code && infoData.error.code !== 'ok')) {
    const normalized = extractTikTokError(infoData, infoRes.status);
    const err = new Error(normalized.message);
    err.payload = normalized;
    throw err;
  }

  return infoData?.data || {};
}

async function uploadImageToFal(image, falKey, index) {
  let buffer;

  if (typeof image === 'string' && image.startsWith('data:')) {
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    buffer = Buffer.from(base64, 'base64');
  } else if (typeof image === 'string' && image.startsWith('http')) {
    const r = await fetch(image);
    if (!r.ok) throw new Error(`Failed to fetch image ${index + 1}: ${r.status}`);
    buffer = Buffer.from(await r.arrayBuffer());
  } else {
    throw new Error(`Image ${index + 1} is not a valid base64 or URL`);
  }

  const falUpload = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content_type: 'image/jpeg',
      file_name: `scheduled_slide_${index}.jpg`,
    }),
  });

  const falData = await falUpload.json();

  if (!falData.upload_url || !falData.file_url) {
    throw new Error(`FAL storage initiate failed for image ${index + 1}`);
  }

  const putRes = await fetch(falData.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer,
  });

  if (!putRes.ok) {
    throw new Error(`FAL upload failed for image ${index + 1}`);
  }

  return falData.file_url;
}

async function postToTikTok(job) {
  const {
    accountToken,
    images,
    caption,
    posting_mode,
  } = job;

  if (!accountToken) throw new Error('No TikTok token for this account');
  if (!images?.length) throw new Error('No images in job');

  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('Missing FAL_KEY in environment');

  const isLive = posting_mode === 'live';
  const cleanTitle = normalizeTitle(caption);
  const cleanDescription = normalizeDescription(caption);

  const photoUrls = [];
  for (let i = 0; i < images.length; i++) {
    const fileUrl = await uploadImageToFal(images[i], falKey, i);
    photoUrls.push(fileUrl);
  }

  const postInfo = {
    title: cleanTitle,
    description: cleanDescription,
  };

  if (isLive) {
    const creatorInfo = await getCreatorInfo(accountToken);
    const privacyOptions = creatorInfo?.privacy_level_options || [];

    postInfo.privacy_level = privacyOptions.includes('PUBLIC_TO_EVERYONE')
      ? 'PUBLIC_TO_EVERYONE'
      : (privacyOptions[0] || 'SELF_ONLY');

    postInfo.disable_comment = false;
    postInfo.auto_add_music = true;
  }

  const initPayload = {
    media_type: 'PHOTO',
    post_mode: isLive ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    post_info: postInfo,
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: photoUrls,
    },
  };

  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accountToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(initPayload),
  });

  const initData = await initRes.json();

  if (!initRes.ok || (initData?.error?.code && initData.error.code !== 'ok')) {
    const normalized = extractTikTokError(initData, initRes.status);
    const extra = normalized.log_id ? ` [log_id: ${normalized.log_id}]` : '';
    throw new Error(normalized.message + extra);
  }

  return {
    publish_id: initData?.data?.publish_id || null,
    post_mode: initPayload.post_mode,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// api/tiktok-auth.js
// Handles:
//   GET  (no code) → redirect to TikTok OAuth URL
//   POST action=refresh_token → refresh an expired access token
//   POST (images) → upload images to Blob + init TikTok post
//
// REMOVED: OAuth callback (GET with ?code=) — now lives exclusively in
//          api/tiktok-callback.js to avoid duplicate token exchanges.
//
// NEW: SAFE_MODE env var — set SAFE_MODE=true in Vercel to test without posting.
// NEW: Blob cleanup via a scheduled DELETE rather than a setTimeout that never
//      fires after Vercel terminates the function.

export const config = { maxDuration: 60 };

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

// Upload image buffer to Vercel Blob — returns serve URL via verified domain
async function uploadToBlob(buffer, fileId, token) {
  const filename = `slides/${fileId}.jpg`;
  const res = await fetch(`https://blob.vercel-storage.com/${filename}`, {
    method: 'PUT',
    headers: {
      'Authorization':        `Bearer ${token}`,
      'Content-Type':         'image/jpeg',
      'x-api-version':        '7',
      // SHORT TTL — 10 minutes is enough for TikTok to pull the image.
      // Previously this was 300s (5 min) but TikTok can be slow — bumped to 600s.
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

// Delete a blob by fileId — called from api/cleanup.js, NOT via setTimeout
// (setTimeout never fires after Vercel terminates the function on response)
export async function deleteBlob(fileId, token) {
  try {
    const filename = `slides/${fileId}.jpg`;
    const listRes  = await fetch(
      `https://blob.vercel-storage.com?prefix=${filename}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'x-api-version': '7' } }
    );
    const listData = await listRes.json();
    const blobUrl  = listData?.blobs?.[0]?.url;
    if (!blobUrl) return;

    await fetch('https://blob.vercel-storage.com/delete', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'x-api-version': '7',
      },
      body: JSON.stringify({ urls: [blobUrl] }),
    });
    console.log('[Blob] deleted:', fileId);
  } catch (e) {
    console.log('[Blob cleanup] failed:', e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const SAFE_MODE = process.env.SAFE_MODE === 'true';

  // ── GET: generate OAuth URL ────────────────────────────────────────────────
  // NOTE: GET with ?code= is now handled by api/tiktok-callback.js only.
  //       This handler no longer processes OAuth callbacks.
  if (req.method === 'GET') {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not set' });

    const redirectUri  = 'https://larry-slidshow.vercel.app/api/tiktok-callback';
    const scope        = 'user.info.basic,video.upload,video.publish';
    const accountIdx   = req.query.account_idx ?? '';
    const state        = `${Math.random().toString(36).slice(2)}_idx${accountIdx}`;

    const authUrl =
      `https://www.tiktok.com/v2/auth/authorize?` +
      `client_key=${clientKey}&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    return res.redirect(authUrl);
  }

  // ── POST: refresh token ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'refresh_token') {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });

    if (SAFE_MODE) {
      console.log('[SAFE MODE] refresh_token skipped');
      return res.json({
        access_token:  'safe_mode_token',
        refresh_token: 'safe_mode_refresh',
        expires_at:    Date.now() + 86400000,
      });
    }

    try {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_key:    process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          grant_type:    'refresh_token',
          refresh_token,
        }),
      });
      const data = await tokenRes.json();
      if (data.error) return res.status(400).json({ error: data.error_description || data.error });
      const expiresAt = Date.now() + ((data.expires_in || 86400) - 300) * 1000;
      return res.json({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    expiresAt,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: upload images + init TikTok post ─────────────────────────────────
  if (req.method === 'POST') {
    const { access_token, images, caption, posting_mode } = req.body;
    if (!access_token || !images?.length)
      return res.status(400).json({ error: 'Missing access_token or images' });

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set' });

    const isLive          = posting_mode === 'live';
    const cleanTitle       = normalizeTitle(caption);
    const cleanDescription = normalizeDescription(caption);
    const uploadedIds      = [];

    // ── SAFE MODE — log and return without posting ────────────────────────
    if (SAFE_MODE) {
      console.log('[SAFE MODE] postDirectToTikTok skipped');
      console.log('[SAFE MODE] title:', cleanTitle);
      console.log('[SAFE MODE] images:', images.length, '| mode:', posting_mode);
      return res.status(200).json({
        ok:        true,
        safe_mode: true,
        publish_id: 'safe_mode_publish_id',
      });
    }

    try {
      // Upload images to Blob, get URLs via verified domain
      const photoUrls = [];
      for (let i = 0; i < images.length; i++) {
        const base64  = images[i].replace(/^data:image\/\w+;base64,/, '');
        const buffer  = Buffer.from(base64, 'base64');
        const fileId  = `${Date.now()}-${i}`;
        const serveUrl = await uploadToBlob(buffer, fileId, blobToken);
        uploadedIds.push(fileId);
        photoUrls.push(serveUrl);
        console.log(`[TikTok] uploaded slide ${i + 1}: ${serveUrl}`);
      }

      // For live posts, fetch valid privacy options
      const postInfo = { title: cleanTitle, description: cleanDescription };
      if (isLive) {
        const creatorRes  = await fetch(
          'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
          {
            method:  'POST',
            headers: {
              'Authorization': `Bearer ${access_token}`,
              'Content-Type':  'application/json; charset=UTF-8',
            },
            body: JSON.stringify({}),
          }
        );
        const creatorData    = await creatorRes.json();
        const privacyOptions = creatorData?.data?.privacy_level_options || [];
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

      console.log('[TikTok] mode:', posting_mode, '| images:', photoUrls.length);

      const initRes  = await fetch(
        'https://open.tiktokapis.com/v2/post/publish/content/init/',
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type':  'application/json; charset=UTF-8',
          },
          body: JSON.stringify(initPayload),
        }
      );

      const initText = await initRes.text();
      let initData;
      try { initData = JSON.parse(initText); }
      catch (e) {
        return res.status(502).json({ error: 'TikTok non-JSON: ' + initText.slice(0, 200) });
      }

      console.log('[TikTok] init response:', JSON.stringify(initData));

      if (!initRes.ok || (initData?.error?.code && initData.error.code !== 'ok')) {
        const normalized = extractTikTokError(initData, initRes.status);
        const extra      = normalized.log_id ? ` [log_id: ${normalized.log_id}]` : '';

        // Store uploadedIds in KV so cleanup job can delete them later
        // (replaces the broken setTimeout approach)
        await scheduleCleanup(uploadedIds);

        return res.status(400).json({
          error:  normalized.message + extra,
          detail: normalized,
        });
      }

      // Schedule blob cleanup via KV (cleanup job runs on next cron tick)
      await scheduleCleanup(uploadedIds);

      return res.status(200).json({
        publish_id: initData?.data?.publish_id,
        ok:         true,
      });

    } catch (e) {
      console.error('[TikTok] error:', e.message);
      await scheduleCleanup(uploadedIds);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}

// ── Blob cleanup queue ────────────────────────────────────────────────────────
// Instead of setTimeout (which dies with the function), push fileIds into KV.
// api/cleanup.js (called by cron) reads this list and deletes the blobs.
async function scheduleCleanup(fileIds) {
  if (!fileIds?.length) return;
  try {
    const { kvRPush } = await import('../lib/kv.js');
    await kvRPush('larry:blob:cleanup', ...fileIds.map(id => ({ id, scheduledAt: Date.now() })));
  } catch (e) {
    console.log('[scheduleCleanup] failed to queue:', e.message);
  }
}

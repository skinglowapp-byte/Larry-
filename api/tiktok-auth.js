// api/tiktok-auth.js
// Handles TikTok OAuth and photo posting via PULL_FROM_URL + Vercel Blob REST API
// Uses Vercel Blob REST API directly (no @vercel/blob package needed)
// Vercel domain (larry-slidshow.vercel.app) is verified in TikTok developer portal

export const config = { maxDuration: 60 };

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const lines = caption ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean) : [];
  const line = lines.find(l => !l.startsWith('#')) || '';
  const cleaned = line.replace(/#\w+/g, '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim();
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
  };
}

// Upload a buffer to Vercel Blob via REST API (no SDK needed)
async function uploadToBlob(buffer, filename, token) {
  const res = await fetch(`https://blob.vercel-storage.com/${filename}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'image/jpeg',
      'x-api-version': '7',
      'x-content-type': 'image/jpeg',
      'x-cache-control-max-age': '60',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blob upload failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.url;
}

// Delete a blob via REST API
async function deleteBlob(url, token) {
  try {
    await fetch('https://blob.vercel-storage.com/delete', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-api-version': '7',
      },
      body: JSON.stringify({ urls: [url] }),
    });
  } catch(e) {
    console.log('[Blob cleanup] failed:', e.message);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Step 1: Generate OAuth URL ───────────────────────────────────────────
  if (req.method === 'GET' && !req.query.code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not set' });

    const redirectUri = `https://larry-slidshow.vercel.app/api/tiktok-callback`;
    const scope = 'user.info.basic,video.upload,video.publish';
    const accountIdx = req.query.account_idx ?? '';
    const state = `${Math.random().toString(36).slice(2)}_idx${accountIdx}`;

    const authUrl = `https://www.tiktok.com/v2/auth/authorize?` +
      `client_key=${clientKey}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    return res.redirect(authUrl);
  }

  // ── Step 2: Handle OAuth callback ───────────────────────────────────────
  if (req.query.code || req.query.error) {
    const { code, error, error_description, state } = req.query;

    if (error) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(error_description || error)}`);
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri = `https://larry-slidshow.vercel.app/api/tiktok-callback`;
    const idxMatch = state?.match(/_idx(\d+)$/);
    const accountIdx = idxMatch ? idxMatch[1] : '';

    try {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        })
      });

      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        return res.redirect(`/?tiktok_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
      }

      const { access_token, refresh_token, expires_in, open_id, scope: grantedScope } = tokenData;
      const expiresAt = Date.now() + ((expires_in || 86400) - 300) * 1000;

      return res.redirect(
        `/?tiktok_connected=1` +
        `&tiktok_token=${encodeURIComponent(access_token)}` +
        `&tiktok_refresh_token=${encodeURIComponent(refresh_token || '')}` +
        `&tiktok_expires_at=${encodeURIComponent(expiresAt)}` +
        `&tiktok_open_id=${encodeURIComponent(open_id)}` +
        `&tiktok_scope=${encodeURIComponent(grantedScope)}` +
        (accountIdx ? `&account_idx=${encodeURIComponent(accountIdx)}` : '')
      );
    } catch (e) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(e.message)}`);
    }
  }

  // ── Step 3: Refresh access token ────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'refresh_token') {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
    try {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token,
        })
      });
      const data = await tokenRes.json();
      if (data.error) return res.status(400).json({ error: data.error_description || data.error });
      const expiresAt = Date.now() + ((data.expires_in || 86400) - 300) * 1000;
      return res.json({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Step 4: Post photos via Vercel Blob + PULL_FROM_URL ──────────────────
  if (req.method === 'POST') {
    const { access_token, images, caption, posting_mode } = req.body;

    if (!access_token || !images || images.length === 0) {
      return res.status(400).json({ error: 'Missing access_token or images' });
    }

    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set in Vercel environment variables' });
    }

    const isLive = posting_mode === 'live';
    const cleanTitle = normalizeTitle(caption);
    const cleanDescription = normalizeDescription(caption);
    const uploadedUrls = [];

    try {
      // Step 1: Upload each image to Vercel Blob via REST API
      const photoUrls = [];
      for (let i = 0; i < images.length; i++) {
        const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        const filename = `slides/${Date.now()}-${i}.jpg`;

        const blobUrl = await uploadToBlob(buffer, filename, blobToken);
        uploadedUrls.push(blobUrl);
        photoUrls.push(blobUrl);
        console.log(`[TikTok] uploaded slide ${i + 1}: ${blobUrl}`);
      }

      // Step 2: For live posts, get valid privacy level
      const postInfo = { title: cleanTitle, description: cleanDescription };

      if (isLive) {
        const creatorRes = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({}),
        });
        const creatorData = await creatorRes.json();
        const privacyOptions = creatorData?.data?.privacy_level_options || [];
        postInfo.privacy_level = privacyOptions.includes('PUBLIC_TO_EVERYONE')
          ? 'PUBLIC_TO_EVERYONE'
          : (privacyOptions[0] || 'SELF_ONLY');
        postInfo.disable_comment = false;
        postInfo.auto_add_music = true;
      }

      // Step 3: Init TikTok post with PULL_FROM_URL
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

      console.log('[TikTok] posting mode:', posting_mode, '| images:', photoUrls.length);

      const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(initPayload),
      });

      const initText = await initRes.text();
      let initData;
      try { initData = JSON.parse(initText); }
      catch(e) { return res.status(502).json({ error: 'TikTok non-JSON: ' + initText.slice(0, 200) }); }

      console.log('[TikTok] init response:', JSON.stringify(initData));

      if (!initRes.ok || (initData?.error?.code && initData.error.code !== 'ok')) {
        const normalized = extractTikTokError(initData, initRes.status);
        const extra = normalized.log_id ? ` [log_id: ${normalized.log_id}]` : '';
        setTimeout(() => uploadedUrls.forEach(u => deleteBlob(u, blobToken)), 5000);
        return res.status(400).json({ error: normalized.message + extra, detail: normalized });
      }

      // Clean up blobs after 60s (TikTok needs time to pull them)
      setTimeout(() => uploadedUrls.forEach(u => deleteBlob(u, blobToken)), 60000);

      return res.status(200).json({ publish_id: initData?.data?.publish_id, ok: true });

    } catch (e) {
      console.error('[TikTok] error:', e.message);
      uploadedUrls.forEach(u => deleteBlob(u, blobToken));
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}

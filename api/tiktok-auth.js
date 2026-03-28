export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

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

  // Step 1: Generate OAuth URL
  if (req.method === 'GET' && !req.query.code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) {
      return res.status(500).json({ ok: false, code: 'missing_client_key', message: 'TIKTOK_CLIENT_KEY not set' });
    }

    const redirectUri =
      process.env.TIKTOK_REDIRECT_URI || `https://${req.headers.host}/api/tiktok-callback`;
    const scope = 'user.info.basic,video.upload,video.publish';

    const accountIdx = req.query.account_idx ?? '';
    const state = `${Math.random().toString(36).slice(2)}_idx${accountIdx}`;

    const authUrl =
      `https://www.tiktok.com/v2/auth/authorize?` +
      `client_key=${clientKey}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scope)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    return res.redirect(authUrl);
  }

  // Step 2: Handle OAuth callback
  if (req.query.code || req.query.error) {
    const { code, error, error_description, state } = req.query;

    if (error) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(error_description || error)}`);
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri =
      process.env.TIKTOK_REDIRECT_URI || `https://${req.headers.host}/api/tiktok-callback`;

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
        }),
      });

      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return res.redirect(
          `/?tiktok_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`
        );
      }

      const {
        access_token,
        refresh_token,
        expires_in,
        open_id,
        scope: grantedScope,
      } = tokenData;

      const expiresAt = Date.now() + ((expires_in || 86400) - 300) * 1000;

      return res.redirect(
        `/?tiktok_connected=1` +
          `&tiktok_token=${encodeURIComponent(access_token)}` +
          `&tiktok_refresh_token=${encodeURIComponent(refresh_token || '')}` +
          `&tiktok_expires_at=${encodeURIComponent(expiresAt)}` +
          `&tiktok_open_id=${encodeURIComponent(open_id)}` +
          `&tiktok_scope=${encodeURIComponent(grantedScope || '')}` +
          (accountIdx ? `&account_idx=${encodeURIComponent(accountIdx)}` : '')
      );
    } catch (e) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(e.message)}`);
    }
  }

  // Step 3: Refresh access token
  if (req.method === 'POST' && req.body?.action === 'refresh_token') {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ ok: false, code: 'missing_refresh_token', message: 'Missing refresh_token' });
    }

    try {
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token,
        }),
      });

      const data = await tokenRes.json();

      if (data.error) {
        return res.status(400).json({
          ok: false,
          code: data.error,
          message: data.error_description || data.error,
        });
      }

      const expiresAt = Date.now() + ((data.expires_in || 86400) - 300) * 1000;

      return res.json({
        ok: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: expiresAt,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        code: 'refresh_failed',
        message: e.message,
      });
    }
  }

  // Step 4: Post photos
  if (req.method === 'POST') {
    const { access_token, images, caption, posting_mode } = req.body;

    if (!access_token || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        ok: false,
        code: 'bad_request',
        message: 'Missing access_token or images',
      });
    }

    const isLive = posting_mode === 'live';
    const cleanTitle = normalizeTitle(caption);
    const cleanDescription = normalizeDescription(caption);

    try {
      const falKey = req.headers['x-fal-key'] || process.env.FAL_KEY;
      if (!falKey) {
        return res.status(500).json({
          ok: false,
          code: 'missing_fal_key',
          message: 'FAL key is not configured',
        });
      }

      const photoUrls = [];

      for (let i = 0; i < images.length; i++) {
        const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');

        const falUpload = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
          method: 'POST',
          headers: {
            'Authorization': `Key ${falKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content_type: 'image/jpeg',
            file_name: `slide_${i}.jpg`,
          }),
        });

        const falData = await falUpload.json();

        if (!falData.upload_url || !falData.file_url) {
          return res.status(500).json({
            ok: false,
            code: 'fal_upload_init_failed',
            message: `FAL storage initiate failed for image ${i + 1}`,
            detail: falData,
          });
        }

        const putRes = await fetch(falData.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: buffer,
        });

        if (!putRes.ok) {
          return res.status(500).json({
            ok: false,
            code: 'fal_upload_failed',
            message: `FAL upload failed for image ${i + 1}`,
            detail: { status: putRes.status },
          });
        }

        photoUrls.push(falData.file_url);
      }

      const postInfo = {
        title: cleanTitle,
        description: cleanDescription,
      };

      if (isLive) {
        const creatorInfo = await getCreatorInfo(access_token);
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
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(initPayload),
      });

      const initData = await initRes.json();

      if (!initRes.ok || (initData?.error?.code && initData.error.code !== 'ok')) {
        const normalized = extractTikTokError(initData, initRes.status);
        return res.status(400).json(normalized);
      }

      return res.status(200).json({
        ok: true,
        publish_id: initData?.data?.publish_id || null,
        post_mode: initPayload.post_mode,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        code: e?.payload?.code || 'server_error',
        message: e.message || 'Unexpected server error',
        log_id: e?.payload?.log_id || null,
        detail: e?.payload?.detail || e?.payload || null,
      });
    }
  }

  return res.status(400).json({ ok: false, code: 'invalid_action', message: 'Invalid action' });
}

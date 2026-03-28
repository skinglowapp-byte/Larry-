export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Step 1: Generate OAuth URL ──────────────────────────────────────────────
  if (req.method === 'GET' && !req.query.code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not set' });

    const redirectUri = process.env.TIKTOK_REDIRECT_URI || `https://${req.headers.host}/api/tiktok-callback`;
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

  // ── Step 2: Handle OAuth callback ───────────────────────────────────────────
  if (req.query.code || req.query.error) {
    const { code, error, error_description, state } = req.query;

    if (error) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(error_description || error)}`);
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri = process.env.TIKTOK_REDIRECT_URI || `https://${req.headers.host}/api/tiktok-callback`;

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

  // ── Step 3: Refresh access token ────────────────────────────────────────────
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

  // ── Step 4: Post photos via push_by_file (no Blob needed) ───────────────────
  if (req.method === 'POST') {
    const { access_token, images, caption, posting_mode } = req.body;

    if (!access_token || !images || images.length === 0) {
      return res.status(400).json({ error: 'Missing access_token or images' });
    }

    const isLive = posting_mode === 'live';

    // Clean title from caption
    const captionLines = caption ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean) : [];
    const titleLine = captionLines.find(l => !l.startsWith('#')) || '';
    const cleanTitle = (titleLine.replace(/#\w+/g, '').replace(/[^a-zA-Z0-9 .,!?'\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)) || 'My skincare journey';

    try {
      // TikTok photo API only supports PULL_FROM_URL — not FILE_UPLOAD
      // We need to upload our base64 images to FAL storage to get public URLs
      const falKey = req.headers['x-fal-key'] || process.env.FAL_KEY;
      
      const photoUrls = [];
      for (let i = 0; i < images.length; i++) {
        const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        
        // Upload to FAL storage to get a public URL
        const falUpload = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
          method: 'POST',
          headers: {
            'Authorization': `Key ${falKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ content_type: 'image/jpeg', file_name: `slide_${i}.jpg` })
        });
        const falData = await falUpload.json();
        
        if (!falData.upload_url) {
          return res.status(500).json({ error: `FAL storage initiate failed for image ${i}`, detail: falData });
        }
        
        // Upload the image bytes to FAL
        const putRes = await fetch(falData.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: buffer
        });
        
        if (!putRes.ok) {
          return res.status(500).json({ error: `FAL upload failed for image ${i}: ${putRes.status}` });
        }
        
        photoUrls.push(falData.file_url);
        console.log(`[TikTok] uploaded slide ${i + 1} to FAL:`, falData.file_url);
      }

      // Step 1: Init the post using PULL_FROM_URL (only supported method for photos)
      const initPayload = {
        media_type: 'PHOTO',
        post_mode: isLive ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
        post_info: {
          title: cleanTitle,
          ...(isLive ? {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            disable_comment: false,
            auto_add_music: true
          } : {})
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: photoUrls
        }
      };

      console.log('[TikTok] mode:', posting_mode, '| title:', cleanTitle, '| images:', photoUrls.length);

      const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify(initPayload)
      });

      const initData = await initRes.json();
      console.log('[TikTok] init response:', JSON.stringify(initData));

      if (initData.error?.code && initData.error.code !== 'ok') {
        return res.status(400).json({ error: initData.error });
      }

      const publishId = initData.data?.publish_id;
      return res.status(200).json({ publish_id: publishId, ok: true });

    } catch (e) {
      console.error('[TikTok] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}

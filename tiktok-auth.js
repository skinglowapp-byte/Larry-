export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Step 1: Generate OAuth URL ──────────────────────────────────────────────
  if (req.method === 'GET' && !req.query.code) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    if (!clientKey) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not set' });

    const redirectUri = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/tiktok-callback`;
    const scope = 'user.info.basic,video.upload,video.publish';
    const state = Math.random().toString(36).slice(2);

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
    const { code, error, error_description } = req.query;

    if (error) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(error_description || error)}`);
    }

    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    const redirectUri = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/tiktok-callback`;

    try {
      // Exchange code for access token
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

      const { access_token, open_id, scope: grantedScope } = tokenData;

      // Redirect back to app with token info (in production store server-side)
      return res.redirect(
        `/?tiktok_connected=1` +
        `&tiktok_token=${encodeURIComponent(access_token)}` +
        `&tiktok_open_id=${encodeURIComponent(open_id)}` +
        `&tiktok_scope=${encodeURIComponent(grantedScope)}`
      );

    } catch (e) {
      return res.redirect(`/?tiktok_error=${encodeURIComponent(e.message)}`);
    }
  }

  // ── Step 3: Post photos to TikTok directly ──────────────────────────────────
  if (req.method === 'POST') {
    const { access_token, open_id, images, caption } = req.body;

    if (!access_token || !images || images.length === 0) {
      return res.status(400).json({ error: 'Missing access_token or images' });
    }

    try {
      // Initialize photo post
      const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify({
          post_info: {
            title: caption.slice(0, 150),
            privacy_level: 'SELF_ONLY',
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
            auto_add_music: true
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_images: images,
            photo_cover_index: 0
          },
          post_mode: 'DIRECT_POST',
          media_type: 'PHOTO'
        })
      });

      const initData = await initRes.json();
      return res.status(initRes.status).json(initData);

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}

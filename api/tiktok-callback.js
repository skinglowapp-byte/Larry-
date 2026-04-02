// api/tiktok-callback.js
// TikTok OAuth callback — receives the code after user approves access.
//
// FIX vs original: redirect URI is now hardcoded to the verified domain
// instead of using req.headers.host, which resolves incorrectly behind
// Vercel's proxy (returns *.vercel.app internals, not larry-slidshow.vercel.app).
//
// This handler is the SINGLE source of truth for OAuth token exchange.
// api/tiktok-auth.js handles only: OAuth URL generation + photo posting.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const { code, error, error_description, state } = req.query;

  // ── Auth error from TikTok ────────────────────────────────────────────────
  if (error) {
    return res.redirect(
      `/?tiktok_error=${encodeURIComponent(error_description || error)}`
    );
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;

  // Hardcoded — must match exactly what's registered in TikTok dev portal
  // DO NOT use req.headers.host here — it breaks behind Vercel's proxy
  const redirectUri = 'https://larry-slidshow.vercel.app/api/tiktok-callback';

  // Extract account index from state param (set during OAuth URL generation)
  const idxMatch   = state?.match(/_idx(\d+)$/);
  const accountIdx = idxMatch ? idxMatch[1] : '';

  // Safe mode — skip token exchange, redirect with dummy token for testing
  if (process.env.SAFE_MODE === 'true') {
    console.log('[SAFE MODE] tiktok-callback: skipping token exchange, code=', code);
    return res.redirect(
      `/?tiktok_connected=1` +
      `&tiktok_token=safe_mode_token` +
      `&tiktok_refresh_token=safe_mode_refresh` +
      `&tiktok_expires_at=${Date.now() + 86400000}` +
      `&tiktok_open_id=safe_mode_open_id` +
      `&tiktok_scope=user.info.basic` +
      (accountIdx ? `&account_idx=${encodeURIComponent(accountIdx)}` : '')
    );
  }

  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key:    clientKey,
        client_secret: clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
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

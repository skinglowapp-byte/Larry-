export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?tiktok_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/tiktok-callback`;

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

    const { access_token, open_id } = tokenData;

    return res.redirect(
      `/?tiktok_connected=1` +
      `&tiktok_token=${encodeURIComponent(access_token)}` +
      `&tiktok_open_id=${encodeURIComponent(open_id)}`
    );

  } catch (e) {
    return res.redirect(`/?tiktok_error=${encodeURIComponent(e.message)}`);
  }
}

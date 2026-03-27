export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'Missing fal key' });

  const authHeaders = {
    'Authorization': `Key ${falKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // POST = submit new job to fal queue, returns request_id immediately
    if (req.method === 'POST') {
      const { endpoint, input } = req.body;
      if (!endpoint || !input) return res.status(400).json({ error: 'Missing endpoint or input' });

      const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(input),
      });
      const text = await submitRes.text();
      try {
        const data = JSON.parse(text);
        return res.status(200).json(data);
      } catch(e) {
        return res.status(502).json({ error: 'fal returned non-JSON: ' + text.slice(0, 300) });
      }
    }

    // GET = proxy a fal queue URL (status or result) — avoids browser CORS block
    if (req.method === 'GET') {
      const { url } = req.query;
      if (!url) return res.status(400).json({ error: 'Missing url param' });

      const proxyRes = await fetch(decodeURIComponent(url), {
        headers: { 'Authorization': `Key ${falKey}` },
      });
      const text = await proxyRes.text();
      try {
        const data = JSON.parse(text);
        return res.status(200).json(data);
      } catch(e) {
        return res.status(502).json({ error: 'fal status returned non-JSON: ' + text.slice(0, 300) });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'Missing fal key' });

  const { endpoint, input } = req.body || {};
  if (!endpoint || !input) return res.status(400).json({ error: 'Missing endpoint or input' });

  const authHeaders = {
    'Authorization': `Key ${falKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Use fal.run (synchronous) — holds connection open, returns when done, no polling needed
    // This avoids the queue timeout problem entirely
    const runRes = await fetch(`https://fal.run/${endpoint}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(input),
    });
    const text = await runRes.text();
    try {
      const data = JSON.parse(text);
      if (!runRes.ok) {
        return res.status(runRes.status).json({ error: data.detail || data.error || 'fal error', raw: data });
      }
      return res.status(200).json(data);
    } catch(e) {
      return res.status(502).json({ error: 'fal non-JSON: ' + text.slice(0, 300) });
    }
  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

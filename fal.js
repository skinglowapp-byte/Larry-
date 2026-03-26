// api/fal.js
// Proxy for all FAL.ai endpoints.
// Uses fal-ai/run (direct) instead of queue to avoid Vercel timeout.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = req.headers['x-fal-key'] || process.env.FAL_KEY;
  if (!falKey) return res.status(400).json({ error: 'Missing FAL API key' });

  const { endpoint, input } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  try {
    // Use direct run endpoint — returns immediately when done, no polling needed
    const runRes = await fetch(`https://fal.run/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    const result = await runRes.json();

    if (!runRes.ok) {
      return res.status(runRes.status).json({ error: result.detail || result.message || 'fal.ai error', details: result });
    }

    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// api/fal.js
// Proxy for fal.ai — submit only mode returns request_id immediately.
// Browser then polls queue directly (no serverless timeout issue).

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
    // Submit to fal queue — returns request_id immediately (fast, no timeout)
    const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    const submitData = await submitRes.json();

    if (!submitData.request_id) {
      return res.status(500).json({ error: 'No request_id from fal', details: submitData });
    }

    // Return request_id — browser polls the queue directly
    return res.status(200).json({ request_id: submitData.request_id });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

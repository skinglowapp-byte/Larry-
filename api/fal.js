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
    // Submit request to fal queue
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

    const requestId = submitData.request_id;

    // Poll for result (max 120 seconds)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(`https://queue.fal.run/${endpoint}/requests/${requestId}/status`, {
        headers: { 'Authorization': `Key ${falKey}` }
      });
      const statusData = await statusRes.json();

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(`https://queue.fal.run/${endpoint}/requests/${requestId}`, {
          headers: { 'Authorization': `Key ${falKey}` }
        });
        const result = await resultRes.json();
        return res.status(200).json(result);
      }

      if (statusData.status === 'FAILED') {
        return res.status(500).json({ error: 'Generation failed', details: statusData });
      }
    }

    return res.status(504).json({ error: 'Timeout waiting for fal result' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

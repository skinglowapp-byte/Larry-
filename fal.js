export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'Missing fal key' });

  const { endpoint, input } = req.body;
  if (!endpoint || !input) return res.status(400).json({ error: 'Missing endpoint or input' });

  const authHeaders = {
    'Authorization': `Key ${falKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Step 1: Submit job to fal queue
    const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(input),
    });
    const submitText = await submitRes.text();
    let submitData;
    try { submitData = JSON.parse(submitText); }
    catch(e) { return res.status(502).json({ error: 'fal submit non-JSON: ' + submitText.slice(0, 200) }); }

    if (!submitData.request_id) {
      return res.status(502).json({ error: 'No request_id from fal: ' + JSON.stringify(submitData) });
    }

    const requestId = submitData.request_id;
    const base = `https://queue.fal.run/${endpoint}/requests/${requestId}`;

    // Step 2: Poll for completion inside this function (max 55s)
    const deadline = Date.now() + 55000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));

      const statusRes = await fetch(`${base}/status`, { headers: authHeaders });
      const statusText = await statusRes.text();
      let statusData;
      try { statusData = JSON.parse(statusText); }
      catch(e) { continue; }

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(base, { headers: authHeaders });
        const resultText = await resultRes.text();
        try {
          const result = JSON.parse(resultText);
          return res.status(200).json(result);
        } catch(e) {
          return res.status(502).json({ error: 'fal result non-JSON: ' + resultText.slice(0, 200) });
        }
      }

      if (statusData.status === 'FAILED') {
        return res.status(500).json({ error: 'fal job failed', detail: statusData });
      }
      // IN_QUEUE or IN_PROGRESS — keep polling
    }

    return res.status(504).json({ error: 'fal timeout after 55s' });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

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
    // Submit to fal queue
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
    // Strip subpath — fal returns 405 if you include /v6 in status/result URLs
    const baseEndpoint = endpoint.split('/').slice(0, 2).join('/');
    const base = `https://queue.fal.run/${baseEndpoint}/requests/${requestId}`;

    // Poll server-side — 50s deadline, sequential calls so no contention
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(`${base}/status`, { headers: authHeaders });
      const statusText = await statusRes.text();
      let statusData;
      try { statusData = JSON.parse(statusText); }
      catch(e) { continue; }

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(base, { headers: authHeaders });
        const resultText = await resultRes.text();
        try {
          return res.status(200).json(JSON.parse(resultText));
        } catch(e) {
          return res.status(502).json({ error: 'fal result non-JSON: ' + resultText.slice(0, 200) });
        }
      }

      if (statusData.status === 'FAILED') {
        return res.status(500).json({ error: 'fal job failed', detail: statusData });
      }
    }

    return res.status(504).json({ error: 'fal timeout after 50s — try again' });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 60 };

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
    if (req.method === 'POST') {
      const { endpoint, input } = req.body || {};
      if (!endpoint || !input) return res.status(400).json({ error: 'Missing endpoint or input' });

      // SUBMIT ONLY — return request_id immediately
      // Browser will poll queue.fal.run directly (GET requests have no CORS restriction)
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

      // Return request_id + baseEndpoint so browser can poll directly
      const baseEndpoint = endpoint.split('/').slice(0, 2).join('/');
      return res.status(200).json({
        request_id: submitData.request_id,
        base_endpoint: baseEndpoint,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

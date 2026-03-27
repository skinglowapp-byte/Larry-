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
    // ── POST: Submit a new job to fal queue ───────────────────────────────
    if (req.method === 'POST') {
      const { endpoint, input } = req.body || {};
      if (!endpoint || !input) return res.status(400).json({ error: 'Missing endpoint or input' });

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

      // ── KEY FIX: Strip subpath for status/result URLs ─────────────────
      // FAL docs: for endpoints like "fal-ai/flux/dev" or "fal-ai/realistic-vision/v6",
      // the subpath (/dev, /v6) must be OMITTED when checking status or fetching results.
      // Using the full path returns 405 Method Not Allowed.
      const baseEndpoint = endpoint.split('/').slice(0, 2).join('/'); // "fal-ai/model-name" only
      const requestId = submitData.request_id;

      // Poll inside this function — avoids browser CORS on queue.fal.run
      // 50s deadline leaves 10s margin for the 60s maxDuration limit
      const deadline = Date.now() + 50000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));

        const statusRes = await fetch(
          `https://queue.fal.run/${baseEndpoint}/requests/${requestId}/status`,
          { headers: authHeaders }
        );
        const statusText = await statusRes.text();
        let statusData;
        try { statusData = JSON.parse(statusText); }
        catch(e) { continue; } // keep polling on parse error

        if (statusData.status === 'COMPLETED') {
          const resultRes = await fetch(
            `https://queue.fal.run/${baseEndpoint}/requests/${requestId}`,
            { headers: authHeaders }
          );
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
        // IN_QUEUE or IN_PROGRESS — keep polling
      }

      return res.status(504).json({ error: 'fal timeout after 50s — job still in queue, try again' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// api/fal.js
// FAL proxy with two modes:
//
// 1. DEFAULT (sync mode) — submit + poll + return result in one call (50s deadline)
//    Used by slideshow generation since slides finish in ~10-30s.
//    Body: { endpoint, input }
//
// 2. ASYNC mode — separate submit / poll / result calls
//    Used by long-running jobs like sync-lipsync (60-90s) and video gen.
//    Body: { action: 'submit', endpoint, input } → returns { request_id }
//          { action: 'status', endpoint, request_id } → returns { status }
//          { action: 'result', endpoint, request_id } → returns full result
//
// Frontend chooses based on job type. Both modes share the same endpoint URL building.

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-fal-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = req.headers['x-fal-key'];
  if (!falKey) return res.status(400).json({ error: 'Missing fal key' });

  const authHeaders = {
    'Authorization': `Key ${falKey}`,
    'Content-Type': 'application/json',
  };

  const body = req.body || {};
  const action = body.action; // 'submit' | 'status' | 'result' | undefined (sync)
  const { endpoint, input, request_id } = body;

  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  // Helper — strip subpath so /requests/{id} works (fal returns 405 if you include /v6)
  const baseEndpoint = endpoint.split('/').slice(0, 2).join('/');

  try {
    // ── ASYNC: SUBMIT ────────────────────────────────────────────────────────
    if (action === 'submit') {
      if (!input) return res.status(400).json({ error: 'Missing input for submit' });
      const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(input),
      });
      const text = await submitRes.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        return res.status(502).json({ error: 'fal submit non-JSON: ' + text.slice(0, 200) });
      }
      if (!data.request_id) {
        return res.status(502).json({ error: 'No request_id from fal: ' + JSON.stringify(data) });
      }
      return res.status(200).json({ request_id: data.request_id, status: data.status || 'IN_QUEUE' });
    }

    // ── ASYNC: STATUS CHECK ──────────────────────────────────────────────────
    if (action === 'status') {
      if (!request_id) return res.status(400).json({ error: 'Missing request_id' });
      const base = `https://queue.fal.run/${baseEndpoint}/requests/${request_id}`;
      const statusRes = await fetch(`${base}/status`, { headers: authHeaders });
      const text = await statusRes.text();
      try {
        return res.status(200).json(JSON.parse(text));
      } catch (e) {
        return res.status(502).json({ error: 'fal status non-JSON: ' + text.slice(0, 200) });
      }
    }

    // ── ASYNC: RESULT FETCH ──────────────────────────────────────────────────
    if (action === 'result') {
      if (!request_id) return res.status(400).json({ error: 'Missing request_id' });
      const base = `https://queue.fal.run/${baseEndpoint}/requests/${request_id}`;
      const resultRes = await fetch(base, { headers: authHeaders });
      const text = await resultRes.text();
      try {
        return res.status(resultRes.status).json(JSON.parse(text));
      } catch (e) {
        return res.status(502).json({ error: 'fal result non-JSON: ' + text.slice(0, 200) });
      }
    }

    // ── SYNC MODE (legacy) — submit + poll + return ──────────────────────────
    if (!input) return res.status(400).json({ error: 'Missing input' });

    const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(input),
    });
    const submitText = await submitRes.text();
    let submitData;
    try { submitData = JSON.parse(submitText); }
    catch (e) { return res.status(502).json({ error: 'fal submit non-JSON: ' + submitText.slice(0, 200) }); }

    if (!submitData.request_id) {
      return res.status(502).json({ error: 'No request_id from fal: ' + JSON.stringify(submitData) });
    }

    const requestId = submitData.request_id;
    const base = `https://queue.fal.run/${baseEndpoint}/requests/${requestId}`;

    // Poll server-side — 50s deadline
    const deadline = Date.now() + 50000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(`${base}/status`, { headers: authHeaders });
      const statusText = await statusRes.text();
      let statusData;
      try { statusData = JSON.parse(statusText); } catch (e) { continue; }

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(base, { headers: authHeaders });
        const resultText = await resultRes.text();
        try {
          return res.status(200).json(JSON.parse(resultText));
        } catch (e) {
          return res.status(502).json({ error: 'fal result non-JSON: ' + resultText.slice(0, 200) });
        }
      }

      if (statusData.status === 'FAILED') {
        return res.status(500).json({ error: 'fal job failed', detail: statusData });
      }
    }

    // Timeout — return request_id so the frontend can keep polling via action: 'result'
    return res.status(504).json({
      error: 'fal timeout after 50s — try again',
      request_id: requestId,
      endpoint: baseEndpoint,
      hint: 'For long jobs, use action:"submit" + action:"result" for client-side polling',
    });

  } catch (err) {
    console.error('[fal proxy] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

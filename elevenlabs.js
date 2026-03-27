// api/elevenlabs.js
// Proxy for ElevenLabs TTS API
// Endpoint: POST /v1/text-to-speech/{voice_id}
// Returns: audio/mpeg binary → converted to base64 for frontend

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-eleven-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = req.headers['x-eleven-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-eleven-key header' });

  // ── GET: list available voices ────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const res2 = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey }
      });
      const data = await res2.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: generate speech ────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { voice_id, text, model_id, stability, similarity_boost } = req.body;

    if (!voice_id || !text) {
      return res.status(400).json({ error: 'Missing voice_id or text' });
    }

    try {
      const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: model_id || 'eleven_multilingual_v2',
          voice_settings: {
            stability: stability ?? 0.5,
            similarity_boost: similarity_boost ?? 0.75,
          }
        })
      });

      if (!ttsRes.ok) {
        const err = await ttsRes.json();
        return res.status(ttsRes.status).json({ error: err });
      }

      // Convert audio buffer to base64 so frontend can play it
      const buffer = await ttsRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');

      return res.status(200).json({
        audio_base64: base64,
        content_type: 'audio/mpeg',
      });

    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

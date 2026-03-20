// api/schedule.js
import { kvGet, kvSet, KEYS } from '../lib/kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { postsPerDay, windowStart, windowEnd, enabled, rotateAccounts } = req.body;
    const config = {
      enabled: !!enabled,
      postsPerDay: parseInt(postsPerDay) || 12,
      windowStart: parseInt(windowStart) || 8,
      windowEnd:   parseInt(windowEnd)   || 22,
      rotateAccounts: rotateAccounts !== false,
      updatedAt: Date.now(),
    };
    await kvSet(KEYS.SCHEDULE, config);
    return res.status(200).json({ ok: true, config });
  }

  if (req.method === 'GET') {
    const config = await kvGet(KEYS.SCHEDULE);
    return res.status(200).json({ config: config || null });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

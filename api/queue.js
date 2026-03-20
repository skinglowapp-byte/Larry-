// api/queue.js
// Queue stored in Vercel KV — persists across cold starts.
//
// Job shape:
// {
//   id, images[], caption, accountIndex, accountToken,
//   scheduledFor (UTC ms), status, hook, accountLabel, createdAt
// }

import { kvLRange, kvRPush, kvLLen, kvSet, kvDel, kvGet, kvLTrim, KEYS } from '../lib/kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: return queue + post log ───────────────────────────────────────────
  if (req.method === 'GET') {
    const [queue, posted] = await Promise.all([
      kvLRange(KEYS.QUEUE, 0, 99999),
      kvLRange(KEYS.POSTED, 0, 49),
    ]);
    return res.status(200).json({ queue, posted, queueLength: queue.length });
  }

  // ── POST: mutate queue ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, jobs, jobId } = req.body;

    if (action === 'add') {
      if (!Array.isArray(jobs) || jobs.length === 0)
        return res.status(400).json({ error: 'jobs must be a non-empty array' });

      const stamped = jobs.map(j => ({
        ...j,
        id: j.id || `job_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        status: 'pending',
        createdAt: Date.now(),
      }));

      await kvRPush(KEYS.QUEUE, ...stamped);

      // Re-sort by scheduledFor
      const all = await kvLRange(KEYS.QUEUE, 0, 99999);
      all.sort((a, b) => a.scheduledFor - b.scheduledFor);
      await kvDel(KEYS.QUEUE);
      if (all.length > 0) await kvRPush(KEYS.QUEUE, ...all);

      return res.status(200).json({ ok: true, added: stamped.length });
    }

    if (action === 'remove') {
      if (!jobId) return res.status(400).json({ error: 'jobId required' });
      const all = await kvLRange(KEYS.QUEUE, 0, 99999);
      const filtered = all.filter(j => j.id !== jobId);
      await kvDel(KEYS.QUEUE);
      if (filtered.length > 0) await kvRPush(KEYS.QUEUE, ...filtered);
      return res.status(200).json({ ok: true });
    }

    if (action === 'clear') {
      await kvDel(KEYS.QUEUE);
      return res.status(200).json({ ok: true });
    }

    // Internal: update a job's status (called by cron)
    if (action === 'update') {
      const { jobId: id, updates } = req.body;
      const all = await kvLRange(KEYS.QUEUE, 0, 99999);
      const updated = all.map(j => j.id === id ? { ...j, ...updates } : j);
      await kvDel(KEYS.QUEUE);
      if (updated.length > 0) await kvRPush(KEYS.QUEUE, ...updated);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

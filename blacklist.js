// api/blacklist.js
// Manages the hook blacklist — prevents low-performing hooks from being reused.
// Ported from the original Larry Go repo's blacklist pattern.
//
// GET  /api/blacklist         → list all blacklisted hooks
// POST /api/blacklist { action: 'add',    hook, reason } → blacklist a hook
// POST /api/blacklist { action: 'remove', hook }         → un-blacklist a hook
// POST /api/blacklist { action: 'clear' }                → clear all

import { kvGet, kvSet, kvDel } from '../lib/kv.js';

const BLACKLIST_KEY = 'larry:hook-blacklist';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: return all blacklisted hooks ─────────────────────────────────────
  if (req.method === 'GET') {
    const data  = await kvGet(BLACKLIST_KEY) || {};
    const items = Object.entries(data).map(([hook, meta]) => ({ hook, ...meta }));
    return res.status(200).json({ items, count: items.length });
  }

  // ── POST: mutate blacklist ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, hook, reason } = req.body;

    if (action === 'add') {
      if (!hook) return res.status(400).json({ error: 'hook required' });
      const current = await kvGet(BLACKLIST_KEY) || {};
      const key     = hook.slice(0, 100);
      current[key]  = { blacklistedAt: Date.now(), reason: reason || '' };
      await kvSet(BLACKLIST_KEY, current);
      return res.status(200).json({ ok: true, blacklisted: key });
    }

    if (action === 'remove') {
      if (!hook) return res.status(400).json({ error: 'hook required' });
      const current = await kvGet(BLACKLIST_KEY) || {};
      delete current[hook.slice(0, 100)];
      await kvSet(BLACKLIST_KEY, current);
      return res.status(200).json({ ok: true });
    }

    if (action === 'clear') {
      await kvDel(BLACKLIST_KEY);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action. Use: add | remove | clear' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

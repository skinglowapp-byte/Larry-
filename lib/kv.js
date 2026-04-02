// lib/kv.js
// Upstash Redis REST client
// Changes vs original:
//   - accountKeys() for per-account queue isolation
//   - kvSetEx() for TTL-based expiry (fixes ever-growing posted list)
//   - blacklist helpers ported from original Larry Go repo
//   - kvFetch handles both encoded and raw values safely

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(command, key, ...valueArgs) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error(
      'Upstash Redis not connected. Add KV_REST_API_URL and KV_REST_API_TOKEN in Vercel env vars.'
    );
  }
  const parts = [command, key, ...valueArgs].filter(v => v !== undefined);
  const url = `${KV_URL}/${parts.join('/')}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ── Basic get/set/del ─────────────────────────────────────────────────────────

export async function kvGet(key) {
  const raw = await kvFetch('GET', key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function kvSet(key, value) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return kvFetch('SET', key, encoded);
}

// Set with TTL in seconds — fixes the ever-growing posted list
export async function kvSetEx(key, value, ttlSeconds) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return kvFetch('SET', key, encoded, 'EX', ttlSeconds);
}

export async function kvDel(key) {
  return kvFetch('DEL', key);
}

// ── List ops ──────────────────────────────────────────────────────────────────

export async function kvRPush(key, ...values) {
  const encoded = values.map(v => encodeURIComponent(JSON.stringify(v)));
  return kvFetch('RPUSH', key, ...encoded);
}

export async function kvLRange(key, start = 0, end = 99999) {
  const items = await kvFetch('LRANGE', key, start, end);
  if (!Array.isArray(items)) return [];
  return items.map(i => {
    try { return JSON.parse(decodeURIComponent(i)); } catch {
      try { return JSON.parse(i); } catch { return i; }
    }
  });
}

export async function kvLLen(key) {
  return kvFetch('LLEN', key);
}

export async function kvLPop(key) {
  const raw = await kvFetch('LPOP', key);
  if (raw === null) return null;
  try { return JSON.parse(decodeURIComponent(raw)); } catch {
    try { return JSON.parse(raw); } catch { return raw; }
  }
}

export async function kvLTrim(key, start, end) {
  return kvFetch('LTRIM', key, start, end);
}

// ── Blacklist helpers (ported from original Larry Go repo) ────────────────────
// Use for hooks that performed poorly — prevents them being reused
// Key format: larry:blacklist:<hookText>

export async function isBlacklisted(hookText) {
  const key = `larry:blacklist:${hookText.slice(0, 100)}`;
  const result = await kvGet(key);
  return result !== null;
}

export async function addToBlacklist(hookText, reason = '') {
  const key = `larry:blacklist:${hookText.slice(0, 100)}`;
  // No expiry — blacklisted hooks stay blacklisted permanently
  return kvSet(key, { blacklistedAt: Date.now(), reason });
}

export async function removeFromBlacklist(hookText) {
  const key = `larry:blacklist:${hookText.slice(0, 100)}`;
  return kvDel(key);
}

// ── Cache expiry formula (ported from original Larry Go repo) ─────────────────
// expirySeconds = cacheSize * periodicityMinutes * 60
// Default: 50 slots * 60 min/post * 60 sec = 180,000s (~2 days)
export function calcCacheExpirySeconds(cacheSize = 50, periodicityMinutes = 60) {
  const seconds = cacheSize * periodicityMinutes * 60;
  return seconds > 0 ? seconds : 0; // 0 = no expiry
}

// ── Key namespacing ───────────────────────────────────────────────────────────
// Per-account keys prevent queue cross-contamination between accounts
// accountLabel should be the account's label slug, e.g. "aureya-main"

function slugify(label) {
  return (label || 'default').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
}

export function accountKeys(accountLabel) {
  const slug = slugify(accountLabel);
  return {
    QUEUE:  `larry:${slug}:queue`,
    POSTED: `larry:${slug}:posted`,
  };
}

// Global keys (shared across all accounts)
export const KEYS = {
  SCHEDULE:    'larry:schedule',
  QUEUE:       'larry:queue',       // legacy global queue — use accountKeys() for new code
  POSTED:      'larry:posted',      // legacy global posted log
  ACCOUNT_IDX: 'larry:account_idx',
};

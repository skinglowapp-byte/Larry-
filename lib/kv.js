// lib/kv.js
// Upstash Redis REST API wrapper — drop-in replacement for Vercel KV.
// 
// Setup (one time):
// 1. Go to upstash.com → Create Database → name it "larry-kv" → free tier
// 2. Copy "UPSTASH_REDIS_REST_URL" and "UPSTASH_REDIS_REST_TOKEN"
// 3. Vercel Dashboard → your project → Settings → Environment Variables → add both
// 4. Redeploy — done.

const KV_URL   = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvFetch(command, ...args) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('Upstash Redis not connected. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel → Settings → Environment Variables.');
  }
  const res = await fetch(`${KV_URL}/${[command, ...args].join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function kvGet(key) {
  const raw = await kvFetch('GET', key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function kvSet(key, value) {
  return kvFetch('SET', key, encodeURIComponent(JSON.stringify(value)));
}

export async function kvDel(key) {
  return kvFetch('DEL', key);
}

export async function kvRPush(key, ...values) {
  // Upstash supports multi-value RPUSH in one call
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

export const KEYS = {
  SCHEDULE:    'larry:schedule',
  QUEUE:       'larry:queue',
  POSTED:      'larry:posted',
  ACCOUNT_IDX: 'larry:account_idx',
};

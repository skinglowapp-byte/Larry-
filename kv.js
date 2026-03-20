// lib/kv.js
// Thin wrapper around Vercel KV REST API.
// Uses fetch directly — no npm package required.
// Vercel auto-injects KV_REST_API_URL and KV_REST_API_TOKEN when you connect a KV store.

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(command, ...args) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('Vercel KV not connected. Add KV store in Vercel Dashboard → Storage.');
  }
  const url = `${KV_URL}/${[command, ...args.map(a => encodeURIComponent(a))].join('/')}`;
  const res = await fetch(url, {
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
  return kvFetch('SET', key, JSON.stringify(value));
}

export async function kvDel(key) {
  return kvFetch('DEL', key);
}

export async function kvRPush(key, ...values) {
  for (const v of values) await kvFetch('RPUSH', key, JSON.stringify(v));
}

export async function kvLRange(key, start = 0, end = 99999) {
  const items = await kvFetch('LRANGE', key, start, end);
  if (!Array.isArray(items)) return [];
  return items.map(i => { try { return JSON.parse(i); } catch { return i; } });
}

export async function kvLLen(key) {
  return kvFetch('LLEN', key);
}

export async function kvLPop(key) {
  const raw = await kvFetch('LPOP', key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
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

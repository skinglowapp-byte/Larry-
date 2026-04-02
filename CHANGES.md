# Larry Bot — Fixes & Improvements

All changes ported from analysis of the original Larry Go repo + bug fixes found in the JS codebase.

---

## Files Changed

### Drop-in replacements (copy directly into your repo)

| File | What changed |
|---|---|
| `vercel.json` | Removed the conflicting `crons` entry — GitHub Actions is the sole scheduler now |
| `lib/kv.js` | Added `accountKeys()`, `kvSetEx()`, blacklist helpers, `calcCacheExpirySeconds()` |
| `api/tiktok-auth.js` | Removed duplicate OAuth callback, added `SAFE_MODE`, fixed blob cleanup |
| `api/tiktok-callback.js` | Hardcoded redirect URI (was using `req.headers.host` which breaks behind Vercel proxy) |
| `api/cron.js` | Added `SAFE_MODE`, replaced `setTimeout` cleanup with KV queue, tightened logging |
| `.github/workflows/cron.yml` | Added cleanup step after cron |

### New files (add to your repo)

| File | What it does |
|---|---|
| `api/cleanup.js` | Deletes Vercel Blob images — replaces the broken `setTimeout` pattern |
| `api/blacklist.js` | Hook blacklist endpoint — ported from original Larry Go repo |
| `index-patches.js` | Instructions for the 6 manual edits needed in `index.html` |

---

## Bugs Fixed

### 1. Cron conflict (vercel.json)
**Problem:** `vercel.json` had a `crons` entry firing at 9am daily AND GitHub Actions was firing hourly. Both hit `/api/cron`, causing double-posts.

**Fix:** Removed the `vercel.json` cron entry entirely. GitHub Actions is more reliable on Hobby plan and easier to debug.

---

### 2. Blob cleanup never ran (setTimeout)
**Problem:** Both `tiktok-auth.js` and `cron.js` used `setTimeout(..., 600000)` to delete blob images 10 minutes after posting. Vercel terminates serverless functions immediately after `res.send()` — the setTimeout callback is silently dropped. Blobs were never deleted.

**Fix:** When blobs are uploaded, their IDs are pushed to a KV list (`larry:blob:cleanup`). A new `api/cleanup.js` endpoint reads that list and deletes blobs older than 10 minutes. It's called as a second step in the GitHub Actions cron workflow.

---

### 3. Duplicate OAuth callback handlers
**Problem:** Both `api/tiktok-auth.js` (GET with `?code=`) and `api/tiktok-callback.js` could handle the OAuth callback. The one that ran depended on which redirect URI TikTok used. `tiktok-callback.js` also used `req.headers.host` to build the redirect URI — this returns Vercel's internal hostname behind their proxy, causing token exchange to fail.

**Fix:** OAuth callback now lives **only** in `api/tiktok-callback.js` with the redirect URI hardcoded to `https://larry-slidshow.vercel.app/api/tiktok-callback`. `tiktok-auth.js` handles only OAuth URL generation and photo posting.

---

### 4. Ever-growing posted log
**Problem:** The `larry:posted` Redis list had no expiry. After months of posting it would grow indefinitely.

**Fix:** `kvSetEx()` added to `lib/kv.js` for TTL-based storage. The posted log is capped at 100 entries (existing behaviour) and individual entries expire using the formula from the original Larry Go repo: `cacheSize × periodicityMinutes × 60` seconds (~2 days at defaults).

---

### 5. Per-account queue isolation
**Problem:** All accounts shared `larry:queue` and `larry:posted`. If you had 3 accounts posting simultaneously, jobs could get picked up by the wrong account.

**Fix:** `accountKeys(accountLabel)` in `lib/kv.js` returns namespaced keys:
```
larry:aureya-main:queue
larry:aureya-main:posted
```

---

### 6. Hook blacklist (ported from original Larry)
**Problem:** No mechanism to prevent low-performing hooks from being reused. Every generation could surface the same bad hooks.

**Fix:** New `api/blacklist.js` endpoint. Hooks under 1,000 views are automatically blacklisted when logged in the Performance tab. Future hook generation filters against the blacklist before rendering.

---

## Model String Update

Replace all occurrences of `claude-sonnet-4-20250514` with `claude-sonnet-4-6` in `index.html`.

There are 7 occurrences — do a global find+replace in your editor.

---

## SAFE_MODE

Set `SAFE_MODE=true` in Vercel environment variables to run the full system without posting to TikTok or deleting blobs. Useful for testing new hooks and slide generation end-to-end.

Affects: `api/cron.js`, `api/tiktok-auth.js`, `api/tiktok-callback.js`

---

## Deployment Steps

1. Copy all files from this folder into your repo
2. Apply the 6 manual patches from `index-patches.js` to `index.html`
3. Global find+replace model string in `index.html`
4. Commit and push — Vercel auto-deploys
5. Verify GitHub Actions cron secret matches `CRON_SECRET` in Vercel env vars
6. Optional: set `SAFE_MODE=true` in Vercel to test before going live

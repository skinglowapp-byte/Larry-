# Larry-
Slideshow Creator for Tiktok uploads
# Larry — TikTok Slideshow Automator

Larry is an AI-powered tool that generates realistic UGC-style skincare slideshows and posts them to TikTok automatically. Built for Aureya and sensitive skin content creators.

---

## Setup

### 1. API Keys

You need three API keys. Add them in the header bar when you open Larry:

- **FAL API Key** — for AI image generation. Get it at [fal.ai](https://fal.ai) → Dashboard → API Keys
- **Anthropic Key** — for hook generation, story planning and captions. Get it at [console.anthropic.com](https://console.anthropic.com)
- **ElevenLabs Key** (optional) — for voiceover generation. Get it at [elevenlabs.io](https://elevenlabs.io)

### 2. Environment Variables (Vercel)

Add these in your Vercel project → Settings → Environment Variables:

| Variable | Description |
|---|---|
| `TIKTOK_CLIENT_KEY` | Your TikTok app client key |
| `TIKTOK_CLIENT_SECRET` | Your TikTok app client secret |
| `TIKTOK_REDIRECT_URI` | `https://larry-slideshow.vercel.app/api/tiktok-auth` |
| `KV_REST_API_URL` | Upstash Redis URL (for scheduler queue) |
| `KV_REST_API_TOKEN` | Upstash Redis token |

### 3. Upstash Redis (for Scheduler)

The scheduler requires a free Redis database:
1. Go to [upstash.com](https://upstash.com) → Create Database → name it `larry-kv` → free tier
2. Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN`
3. Add both to Vercel environment variables
4. Redeploy

---

## Workflow

### Step 1 — Setup Tab
- Set your **App name** (e.g. Aureya)
- Set your **App one-liner** and **Target audience**
- Set your **Image architecture** — the locked character description used across all 6 slides
- Customise the **6 slide style variants** if needed

### Step 2 — Hook Generator
- Generate 10 hooks using Claude based on your niche
- Select the hook that will become Slide 1
- Or paste your own hook

### Step 3 — Generate Slideshow
- Your selected hook auto-populates
- Click **✦ Generate all 6 slides**
- Claude plans the story arc, then all 6 slides generate in parallel
- Each slide goes through:
  - **Pass 1** — Realistic Vision V6 image generation via fal.ai
  - **Pass 2** — Crystal face enhancement (sharpens skin detail)
- Text overlay is composited onto each slide automatically

### Step 4 — Caption
- Click **Generate caption** for a TikTok-ready story caption with hashtags
- Choose caption style: Story-style, Problem/Solution, or Educational
- Use **Copy caption** to copy to clipboard

### Step 5 — Post to TikTok
- **⬆ Save to Drafts** — sends slideshow to your TikTok drafts inbox (approved, works now)
- **✦ Post Live** — posts directly to TikTok (requires Direct Post API approval)
- **↓ Download slides** — downloads all 6 slides as a zip for manual upload

---

## Accounts

Go to the **Accounts** tab to:
- Connect multiple TikTok accounts via OAuth
- Upload a **character photo** per account (used for face consistency)
- Train a **LoRA** per account — trains a custom AI model on the character face for maximum slide-to-slide consistency (takes ~20 mins, dramatically improves realism)

### LoRA Training (Recommended)
1. Upload a clear character photo to the account
2. Click **⚡ Start LoRA Training**
3. Wait ~20 minutes
4. Generate a new slideshow — the trained face will appear consistently across all 6 slides

---

## Scheduler

The scheduler auto-posts slideshows at optimal times:

1. Generate a slideshow and caption
2. Go to **Scheduler** tab
3. Set posts per day and posting window (e.g. 8am–10pm)
4. Click **+ Add to queue**
5. The hourly cron job posts automatically at the scheduled times

Queue is stored in Upstash Redis and persists across server restarts.

---

## Performance Log

Track which hooks and slideshows perform best:

1. After posting, go to **Performance Log**
2. Enter the hook text, view count, and lesson learned
3. Use the insights to improve future hooks

---

## Bulk Generate

Generate multiple slideshows at once using different hooks:

1. Set **Number of slideshows** (1–10)
2. Paste hooks (one per line) or leave empty to auto-generate
3. Click **✦ Bulk generate slideshows**
4. Each slideshow downloads as a separate zip

---

## TikTok API Status

| Feature | Status |
|---|---|
| OAuth account connection | ✅ Approved |
| Save to Drafts (INBOX) | ✅ Approved |
| Direct Post (live) | ⏳ Pending approval (2–4 weeks) |

Once Direct Post is approved, switch the posting mode toggle in **Setup** from Sandbox → Live.

---

## Tech Stack

- **Frontend** — Vanilla HTML/CSS/JS, single file (`index.html`)
- **Image generation** — fal.ai (Realistic Vision V6 + Crystal Upscaler)
- **AI text** — Anthropic Claude (hooks, story planning, captions)
- **Voiceover** — ElevenLabs
- **TikTok** — Content Posting API (push_by_file, no Blob storage)
- **Queue/Scheduler** — Upstash Redis + Vercel Cron
- **Hosting** — Vercel

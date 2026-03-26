// api/cron.js
// Runs every hour via Vercel cron.
// Reads scheduled queue from localStorage (passed via client) — no KV needed.
// Since this is a serverless function, the queue is stored client-side and
// submitted to this endpoint when jobs are due.

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Jobs are submitted directly from the client scheduler
  // This endpoint just processes a single job passed in the request body
  if (req.method === 'POST') {
    const { job } = req.body;
    if (!job) return res.status(400).json({ error: 'No job provided' });

    try {
      await postToTikTok(job);
      return res.status(200).json({ ok: true, id: job.id, status: 'posted' });
    } catch (e) {
      return res.status(500).json({ ok: false, id: job.id, error: e.message });
    }
  }

  // GET — health check
  return res.status(200).json({ ok: true, message: 'Cron endpoint ready' });
}

async function postToTikTok(job) {
  const { accountToken, images, caption, posting_mode } = job;
  if (!accountToken) throw new Error('No TikTok token for this account');
  if (!images?.length) throw new Error('No images');

  const isLive = posting_mode === 'live';

  // Clean title from caption
  const captionLines = caption ? caption.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean) : [];
  const titleLine = captionLines.find(l => !l.startsWith('#')) || '';
  const cleanTitle = titleLine.replace(/#\w+/g, '').replace(/[<>"]/g, '').trim().slice(0, 150) || 'Skincare story';

  // Convert base64 images to buffers
  const imageBuffers = images.map(img => {
    const base64 = img.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64, 'base64');
  });

  // Step 1: Init the post
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accountToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({
      post_info: {
        title: cleanTitle,
        privacy_level: isLive ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        auto_add_music: true,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        photo_cover_index: 0,
        photo_count: imageBuffers.length
      },
      post_mode: isLive ? 'DIRECT_POST' : 'INBOX',
      media_type: 'PHOTO'
    })
  });

  const initData = await initRes.json();
  if (initData.error?.code && initData.error.code !== 'ok') {
    throw new Error(initData.error.message || JSON.stringify(initData.error));
  }

  const uploadUrls = initData.data?.upload_urls;
  if (!uploadUrls?.length) throw new Error('No upload URLs returned from TikTok');

  // Step 2: Upload each image
  for (let i = 0; i < uploadUrls.length; i++) {
    const uploadRes = await fetch(uploadUrls[i], {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: imageBuffers[i]
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Image upload ${i + 1} failed: ${errText}`);
    }
  }

  return { publish_id: initData.data?.publish_id };
}

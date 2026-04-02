// api/cleanup.js
// Blob cleanup job — deletes uploaded slide images from Vercel Blob
// after TikTok has had time to pull them.
//
// WHY THIS EXISTS:
// The original code used setTimeout(..., 600000) inside tiktok-auth.js and
// cron.js to delete blobs. This never actually ran in production because
// Vercel terminates serverless functions immediately after the response is sent.
// setTimeout callbacks scheduled after res.send() are silently dropped.
//
// FIX: Instead of setTimeout, we push blob IDs into a KV list (larry:blob:cleanup).
// This endpoint reads that list and deletes any blobs older than 10 minutes.
// It is called by the same GitHub Actions cron that triggers api/cron — just
// add a second step to .github/workflows/cron.yml.
//
// SETUP — add to .github/workflows/cron.yml:
//   - name: Cleanup old blobs
//     run: |
//       curl -s -X POST \
//         -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
//         "https://larry-slidshow.vercel.app/api/cleanup"

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Auth — same secret as cron
  const authHeader = req.headers.authorization;
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set' });

  const { kvLRange, kvDel, kvRPush } = await import('../lib/kv.js');

  // Read all pending cleanup items
  const pending = await kvLRange('larry:blob:cleanup', 0, 99999);
  if (!pending.length) {
    return res.status(200).json({ ok: true, message: 'Nothing to clean up' });
  }

  const now         = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  const ready       = pending.filter(item => now - (item.scheduledAt || 0) >= TEN_MINUTES);
  const notYet      = pending.filter(item => now - (item.scheduledAt || 0) <  TEN_MINUTES);

  const deleted = [];
  const failed  = [];

  for (const item of ready) {
    try {
      const fileId   = item.id || item;
      const filename = `slides/${fileId}.jpg`;

      // Step 1: list to get the actual blob URL
      const listRes  = await fetch(
        `https://blob.vercel-storage.com?prefix=${filename}`,
        { headers: { 'Authorization': `Bearer ${blobToken}`, 'x-api-version': '7' } }
      );
      const listData = await listRes.json();
      const blobUrl  = listData?.blobs?.[0]?.url;

      if (!blobUrl) {
        // Already gone — just remove from queue
        deleted.push(fileId);
        continue;
      }

      // Step 2: delete
      const delRes = await fetch('https://blob.vercel-storage.com/delete', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${blobToken}`,
          'Content-Type':  'application/json',
          'x-api-version': '7',
        },
        body: JSON.stringify({ urls: [blobUrl] }),
      });

      if (delRes.ok) {
        deleted.push(fileId);
        console.log('[cleanup] deleted blob:', fileId);
      } else {
        const text = await delRes.text();
        failed.push({ fileId, error: text });
        console.error('[cleanup] delete failed:', fileId, text);
      }
    } catch (e) {
      failed.push({ fileId: item.id || item, error: e.message });
    }
  }

  // Rewrite the cleanup queue — keep only items not yet ready
  await kvDel('larry:blob:cleanup');
  if (notYet.length > 0) {
    await kvRPush('larry:blob:cleanup', ...notYet);
  }
  // Re-add failed items so they retry next time
  if (failed.length > 0) {
    const retryItems = failed.map(f => ({
      id:          f.fileId,
      scheduledAt: Date.now(), // reset timer so it retries in 10 min
    }));
    await kvRPush('larry:blob:cleanup', ...retryItems);
  }

  return res.status(200).json({
    ok:      true,
    deleted: deleted.length,
    failed:  failed.length,
    pending: notYet.length,
    details: { deleted, failed },
  });
}

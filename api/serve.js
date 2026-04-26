// api/serve.js
// Serves Blob images through larry-slidshow.vercel.app (TikTok verified domain)
// TikTok pulls from: https://larry-slidshow.vercel.app/api/serve?id=<fileId>.jpg
// Direct fetch — no list step, much faster

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return res.status(500).send('BLOB_READ_WRITE_TOKEN not set');

  try {
    // Construct the blob URL directly — no list step needed
    // Vercel Blob public URLs follow a predictable pattern
    // We store as slides/<id> so fetch directly via the blob API
    const directUrl = `https://blob.vercel-storage.com/slides/${id}`;
    
    const imgRes = await fetch(directUrl, {
      headers: {
        'Authorization': `Bearer ${blobToken}`,
      }
    });

    if (!imgRes.ok) {
      console.error(`[serve] Blob fetch failed: ${imgRes.status} for id=${id}`);
      return res.status(404).send(`Image not found: ${imgRes.status}`);
    }

    const buffer = await imgRes.arrayBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    console.error('[serve] error:', e.message);
    return res.status(500).send(e.message);
  }
}

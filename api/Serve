// api/serve.js
// Serves Blob images through larry-slidshow.vercel.app (TikTok verified domain)
// TikTok pulls from: https://larry-slidshow.vercel.app/api/serve?id=<filename>

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('Missing id');

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) return res.status(500).send('BLOB_READ_WRITE_TOKEN not set');

  try {
    // List blobs to find the one matching this id
    const listRes = await fetch(`https://blob.vercel-storage.com?prefix=slides/${id}`, {
      headers: {
        'Authorization': `Bearer ${blobToken}`,
        'x-api-version': '7',
      }
    });

    const listData = await listRes.json();
    const blob = listData?.blobs?.[0];
    if (!blob?.url) return res.status(404).send('Image not found');

    // Fetch the actual image from Blob storage
    const imgRes = await fetch(blob.url);
    if (!imgRes.ok) return res.status(404).send('Image fetch failed');

    const buffer = await imgRes.arrayBuffer();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    console.error('[serve] error:', e.message);
    res.status(500).send(e.message);
  }
}

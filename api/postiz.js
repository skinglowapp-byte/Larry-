export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-postiz-key, x-postiz-path, x-content-type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const postizKey = req.headers['x-postiz-key'];
  const postizPath = req.headers['x-postiz-path'] || '/public/posts';
  const contentType = req.headers['x-content-type'] || 'application/json';

  if (!postizKey) return res.status(400).json({ error: 'Missing x-postiz-key header' });

  try {
    let body;
    let headers = { 'Authorization': `Bearer ${postizKey}` };

    if (contentType === 'multipart') {
      // Handle base64 file upload
      const { base64, filename } = req.body;
      const buffer = Buffer.from(base64, 'base64');
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      
      const formParts = [
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
        `Content-Type: image/png\r\n\r\n`,
      ];
      
      const formStart = Buffer.from(formParts.join(''));
      const formEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
      body = Buffer.concat([formStart, buffer, formEnd]);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`https://api.postiz.com${postizPath}`, {
      method: 'POST',
      headers,
      body,
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

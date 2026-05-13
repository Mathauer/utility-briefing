const https = require('https');

exports.handler = async function(event) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_KEY) {
    return { statusCode: 200, body: JSON.stringify({ error: 'No API key set' }) };
  }

  const bodyStr = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve({ raw: buf }); } });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

  const text = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: !result.error,
      text: text || null,
      error: result.error || null,
      stop_reason: result.stop_reason || null,
    }),
  };
};

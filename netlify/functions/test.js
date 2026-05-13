const https = require('https');
const tls   = require('tls');

exports.handler = async function(event) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GMAIL_USER    = process.env.GMAIL_USER;
  const GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;
  const RECIPIENTS    = (process.env.BRIEFING_EMAIL || 'mathauer@gmail.com')
                          .split(/[,;]/).map(e => e.trim()).filter(e => e.includes('@'));

  // Step 1: Quick Anthropic call
  let anthropicOk = false;
  let anthropicError = null;
  try {
    const bodyStr = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Say ok.' }],
    });
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(bodyStr) },
      }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
      req.on('error', reject);
      req.write(bodyStr); req.end();
    });
    anthropicOk = !result.error;
    if (result.error) anthropicError = result.error.message;
  } catch(e) { anthropicError = e.message; }

  // Step 2: Test SMTP connection only (no send)
  let smtpOk = false;
  let smtpError = null;
  try {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
      socket.setTimeout(8000);
      socket.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line.startsWith('220')) {
          smtpOk = true;
          socket.end();
          resolve();
        }
      });
      socket.on('error', (e) => { smtpError = e.message; reject(e); });
      socket.on('timeout', () => { smtpError = 'timeout'; socket.destroy(); reject(new Error('timeout')); });
      socket.on('end', resolve);
    });
  } catch(e) { smtpError = smtpError || e.message; }

  return {
    statusCode: 200,
    body: JSON.stringify({
      node: process.version,
      anthropic: { ok: anthropicOk, error: anthropicError },
      smtp: { ok: smtpOk, error: smtpError },
      recipients: RECIPIENTS,
      gmail_user_set: !!GMAIL_USER,
      gmail_pass_set: !!GMAIL_APP_PASS,
    }, null, 2),
  };
};

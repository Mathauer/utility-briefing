const https = require('https');

// Send email via Mailgun's free API (no SMTP config needed)
// Falls back to a simple response if not configured so the site still works.
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { to, subject, html, text } = JSON.parse(event.body);

    const MAILGUN_API_KEY  = process.env.MAILGUN_API_KEY;
    const MAILGUN_DOMAIN   = process.env.MAILGUN_DOMAIN;
    const FROM_EMAIL       = process.env.FROM_EMAIL || `briefing@${MAILGUN_DOMAIN}`;

    // If Mailgun is not configured, tell the client to fall back to mailto
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, reason: 'Email service not configured — using mailto fallback' }),
      };
    }

    // Build multipart form body for Mailgun REST API
    const formData = [
      `from=${encodeURIComponent(FROM_EMAIL)}`,
      `to=${encodeURIComponent(to)}`,
      `subject=${encodeURIComponent(subject)}`,
      `text=${encodeURIComponent(text)}`,
      `html=${encodeURIComponent(html)}`,
    ].join('&');

    const credentials = Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.mailgun.net',
        path: `/v3/${MAILGUN_DOMAIN}/messages`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(formData),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(formData);
      req.end();
    });

    if (result.status === 200 || result.status === 201) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      };
    } else {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, reason: result.body }),
      };
    }

  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, reason: err.message }),
    };
  }
};

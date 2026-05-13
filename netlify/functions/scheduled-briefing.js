const https = require('https');

const RECIPIENT_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
const GMAIL_USER      = process.env.GMAIL_USER;
const GMAIL_APP_PASS  = process.env.GMAIL_APP_PASSWORD;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const NEWS_API_KEY    = process.env.NEWS_API_KEY || '';

const UTILITIES = [
  { name: 'Georgia Power',            query: 'Georgia Power utility energy' },
  { name: 'Duke Energy',              query: 'Duke Energy utility' },
  { name: 'Dominion Energy',          query: 'Dominion Energy utility' },
  { name: 'San Diego Gas & Electric', query: 'San Diego Gas Electric SDG&E' },
];

// ── Simple HTTPS POST helper (no dependencies) ─────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { resolve(buf); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Simple HTTPS GET helper ────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({}); }
      });
    }).on('error', reject);
  });
}

// ── Fetch headlines from NewsAPI ───────────────────────────────────────────
async function fetchHeadlines(query) {
  if (!NEWS_API_KEY) return [];
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&language=en&apiKey=${NEWS_API_KEY}`;
    const data = await httpsGet(url);
    return (data.articles || []).map(a => `- ${a.title} (${a.source?.name || 'unknown'})`);
  } catch(e) {
    console.error('NewsAPI error:', e.message);
    return [];
  }
}

// ── Call Claude ────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const data = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }
  );

  if (data.error) {
    console.error('Claude error:', data.error.message);
    return null;
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  console.log('Claude response:', text.length, 'chars');
  return text;
}

// ── Send email via Gmail SMTP using raw HTTPS ──────────────────────────────
async function sendEmail(subject, htmlBody, plainBody) {
  // Base64 encode credentials for Basic auth
  const credentials = Buffer.from(`${GMAIL_USER}:${GMAIL_APP_PASS}`).toString('base64');

  // Build raw RFC 2822 email message
  const boundary = 'boundary_' + Date.now();
  const rawEmail = [
    `From: Utility Briefing <${GMAIL_USER}>`,
    `To: ${RECIPIENT_EMAIL}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    plainBody,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const encodedEmail = Buffer.from(rawEmail).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const result = await httpsPost(
    'gmail.googleapis.com',
    '/gmail/v1/users/me/messages/send',
    {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`,
    },
    { raw: encodedEmail }
  );

  console.log('Gmail result:', JSON.stringify(result).slice(0, 200));
  return result;
}

// ── Send via SMTP using nodemailer-style raw SMTP isn't available ──────────
// Use Gmail API with OAuth2 or fall back to sending via Anthropic prompt
// Simplest working approach: use smtp.gmail.com via net module

async function sendViaSmtp(subject, htmlBody, plainBody) {
  const tls = require('tls');

  return new Promise((resolve, reject) => {
    const b64creds = Buffer.from(`\0${GMAIL_USER}\0${GMAIL_APP_PASS}`).toString('base64');
    const boundary = 'b' + Date.now();
    const msgBody = [
      `From: Utility Briefing <${GMAIL_USER}>`,
      `To: ${RECIPIENT_EMAIL}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      plainBody,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    // State machine: wait for a code then send next command
    const conversation = [
      { wait: '220', send: `EHLO netlify.app\r\n` },
      { wait: '250', send: `AUTH PLAIN ${b64creds}\r\n` },
      { wait: '235', send: `MAIL FROM:<${GMAIL_USER}>\r\n` },
      { wait: '250', send: `RCPT TO:<${RECIPIENT_EMAIL}>\r\n` },
      { wait: '250', send: `DATA\r\n` },
      { wait: '354', send: msgBody + '\r\n.\r\n' },
      { wait: '250', send: `QUIT\r\n` },
      { wait: '221', send: null },
    ];

    let idx = 0;
    let buf = '';

    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });

    socket.on('error', (err) => {
      console.error('SMTP socket error:', err.message);
      reject(err);
    });

    socket.on('end', () => {
      console.log('SMTP connection closed');
      resolve({ ok: true });
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      // Process complete lines
      const lines = buf.split('\r\n');
      buf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line) continue;
        console.log('S:', line);

        // Only act on final response lines (no dash continuation e.g. "250-...")
        const code = line.slice(0, 3);
        const isFinal = line[3] === ' ' || line.length === 3;

        if (!isFinal) continue; // multi-line response, wait for final

        if (idx < conversation.length && code === conversation[idx].wait) {
          const next = conversation[idx].send;
          idx++;
          if (next) {
            const preview = next.length > 60 ? next.slice(0, 60) + '...' : next.trim();
            console.log('C:', preview);
            socket.write(next);
          } else {
            // Done
            socket.end();
            resolve({ ok: true });
          }
        } else if (code.startsWith('4') || code.startsWith('5')) {
          reject(new Error('SMTP error: ' + line));
        }
      }
    });
  });
}

// ── Build HTML email ───────────────────────────────────────────────────────
function buildEmail(allData, script, dateStr) {
  const catMap = {
    ma:         { bg: '#EEEDFE', color: '#3C3489', label: 'M&A' },
    financial:  { bg: '#E1F5EE', color: '#085041', label: 'Financial' },
    regulatory: { bg: '#FAEEDA', color: '#633806', label: 'Regulatory' },
    news:       { bg: '#E6F1FB', color: '#0C447C', label: 'News' },
  };

  const utilitySections = allData.map(d => {
    const newsRows = (d.news || []).map(n => {
      const cat = catMap[n.category] || catMap.news;
      return `<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">${n.headline}</p>
        <p style="margin:0 0 5px;font-size:12px;">
          <span style="background:${cat.bg};color:${cat.color};padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">${cat.label}</span>
          &nbsp;${n.source || ''}
        </p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">${n.summary || ''}</p>
      </div>`;
    }).join('');
    return `<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:4px;">${d.utility}</div>
      <p style="margin:0 0 14px;font-size:14px;color:#555;">${d.key_takeaway || ''}</p>
      ${newsRows || '<p style="color:#aaa;font-size:13px;">No items retrieved.</p>'}
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f3;font-family:-apple-system,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:24px 16px;">
  <div style="background:#1a1a1a;border-radius:10px;padding:24px 28px;margin-bottom:20px;">
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:600;color:#fff;">Utility Partners Update</h1>
    <p style="margin:0;font-size:13px;color:#aaa;">${dateStr}</p>
  </div>
  <div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px 24px;margin-bottom:20px;">
    <div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:10px;">🎧 Commute Summary</div>
    <p style="margin:0;font-size:14px;color:#333;line-height:1.8;">${script}</p>
  </div>
  ${utilitySections}
</div></body></html>`;

  const plain = `Utility Briefing — ${dateStr}\n\n${script}\n\n---\n${allData.map(d => `${d.utility}: ${d.key_takeaway}`).join('\n')}`;
  return { html, plain };
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async function(event) {
  console.log('Utility briefing starting...');

  if (!ANTHROPIC_KEY || !GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('Missing env vars. ANTHROPIC_KEY:', !!ANTHROPIC_KEY, 'GMAIL_USER:', !!GMAIL_USER, 'GMAIL_APP_PASS:', !!GMAIL_APP_PASS);
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  try {
    // Fetch headlines
    console.log('Fetching headlines...');
    const headlinesByUtility = {};
    for (const u of UTILITIES) {
      const lines = await fetchHeadlines(u.query);
      headlinesByUtility[u.name] = lines;
      console.log(`${u.name}: ${lines.length} headlines`);
    }

    // Build prompt for Claude
    const context = UTILITIES.map(u => {
      const lines = headlinesByUtility[u.name];
      return `${u.name}:\n${lines.length ? lines.join('\n') : '- No recent headlines found'}`;
    }).join('\n\n');

    const prompt = `You are preparing a daily intelligence briefing for a utility industry executive.

Today's headlines:
${context}

Return ONLY valid JSON (no markdown, no backticks):
{
  "utilities": [
    {"utility":"Georgia Power","key_takeaway":"one sentence","news":[{"headline":"...","category":"news","summary":"1-2 sentences","source":"..."}]},
    {"utility":"Duke Energy","key_takeaway":"...","news":[...]},
    {"utility":"Dominion Energy","key_takeaway":"...","news":[...]},
    {"utility":"San Diego Gas & Electric","key_takeaway":"...","news":[...]}
  ],
  "commute_script": "Good morning. Here's your utility briefing for ${dateStr}. [3 minute spoken summary covering each utility. Natural spoken language.]"
}`;

    console.log('Calling Claude...');
    const rawText = await callClaude(prompt);

    if (!rawText) throw new Error('No response from Claude');

    const clean = rawText.replace(/```json|```/gi, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start === -1) throw new Error('No JSON in Claude response: ' + clean.slice(0, 100));

    const result = JSON.parse(clean.slice(start, end + 1));
    console.log('Parsed OK:', (result.utilities || []).length, 'utilities');

    const { html, plain } = buildEmail(result.utilities || [], result.commute_script || '', dateStr);

    console.log('Sending email via SMTP...');
    await sendViaSmtp(`⚡ Utility Briefing — ${dateStr}`, html, plain);

    console.log('Done. Briefing sent to', RECIPIENT_EMAIL);
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch(err) {
    console.error('Failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

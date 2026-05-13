const https = require('https');
const tls   = require('tls');

const RECIPIENT_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
const RECIPIENTS      = RECIPIENT_EMAIL.split(/[,;]/).map(e => e.trim()).filter(e => e.includes('@'));
const GMAIL_USER      = process.env.GMAIL_USER;
const GMAIL_APP_PASS  = process.env.GMAIL_APP_PASSWORD;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

const UTILITIES = [
  'Georgia Power',
  'Duke Energy',
  'Dominion Energy',
  'San Diego Gas & Electric',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Call Anthropic with web search (mirrors proxy.js exactly) ─────────────────
async function callAnthropicWithWebSearch(payload, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const bodyStr = JSON.stringify(payload);
      const result  = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.anthropic.com',
            path:     '/v1/messages',
            method:   'POST',
            headers:  {
              'Content-Type':    'application/json',
              'x-api-key':       ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta':  'web-search-2025-03-05',
              'Content-Length':  Buffer.byteLength(bodyStr),
            },
          },
          (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
              try { resolve(JSON.parse(buf)); }
              catch(e) { reject(new Error('JSON parse failed: ' + buf.slice(0, 100))); }
            });
          }
        );
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });

      // Check for rate limit error — wait and retry
      if (result.error && result.error.type === 'rate_limit_error') {
        console.log(`Rate limit hit (attempt ${attempt}/${retries}). Waiting 30s...`);
        if (attempt < retries) { await sleep(30000); continue; }
      }

      return result;
    } catch(err) {
      console.error(`Attempt ${attempt} failed:`, err.message);
      if (attempt < retries) { await sleep(10000); continue; }
      throw err;
    }
  }
}

// ── Fetch one utility using web search (same as website) ──────────────────────
async function fetchUtilityData(utility) {
  const prompt = `Find 3 recent news items about ${utility}. Return ONLY valid JSON, no markdown:
{"utility":"${utility}","key_takeaway":"one sentence summary","news":[{"headline":"...","category":"news|ma|financial|regulatory","summary":"1-2 sentences","source":"publication"}]}`;

  console.log(`Fetching: ${utility}...`);

  const data = await callAnthropicWithWebSearch({
    model:      'claude-sonnet-4-5',
    max_tokens: 600,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: prompt }],
  });

  if (data.error) {
    console.error(`${utility} error:`, data.error.message);
    return { utility, key_takeaway: 'Data unavailable.', news: [] };
  }

  const text  = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');

  if (start === -1) {
    console.warn(`${utility}: no JSON found. Text sample:`, text.slice(0, 150));
    return { utility, key_takeaway: 'Could not parse response.', news: [] };
  }

  try {
    const parsed = JSON.parse(clean.slice(start, end + 1));
    console.log(`${utility}: OK — ${(parsed.news || []).length} items`);
    return parsed;
  } catch(e) {
    console.error(`${utility} parse error:`, e.message);
    return { utility, key_takeaway: 'Could not parse response.', news: [] };
  }
}

// ── Generate commute script (same as website) ─────────────────────────────────
async function generateCommuteScript(allData, dateStr) {
  const summary = allData.map(d =>
    `${d.utility}: ${d.key_takeaway}. Headlines: ${(d.news || []).slice(0, 2).map(n => n.headline).join('; ')}.`
  ).join('\n\n');

  const bodyStr = JSON.stringify({
    model:      'claude-sonnet-4-5',
    max_tokens: 400,
    messages:   [{
      role:    'user',
      content: `Write a spoken morning commute briefing for a utility executive. Conversational, ~3 min read aloud. Based on:\n${summary}\n\nStart: "Good morning. Here's your utility briefing for ${dateStr}." Cover each partner briefly. End with one overall takeaway. No bullet points, no headers.`,
    }],
  });

  const data = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Build HTML email ──────────────────────────────────────────────────────────
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
        <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;line-height:1.4;">${n.headline}</p>
        <p style="margin:0 0 5px;font-size:12px;">
          <span style="background:${cat.bg};color:${cat.color};padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">${cat.label}</span>
          &nbsp;${n.source || ''}
        </p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">${n.summary || ''}</p>
      </div>`;
    }).join('');
    return `<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#aaa;margin-bottom:4px;">${d.utility}</div>
      <p style="margin:0 0 14px;font-size:14px;color:#555;">${d.key_takeaway || ''}</p>
      ${newsRows || '<p style="color:#aaa;font-size:13px;">No items retrieved.</p>'}
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:24px 16px;">
  <div style="background:#1a1a1a;border-radius:10px;padding:24px 28px;margin-bottom:20px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:6px;">Daily Intelligence Briefing</div>
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:600;color:#fff;">Utility Partners Update</h1>
    <p style="margin:0;font-size:13px;color:#aaa;">${dateStr}</p>
    <p style="margin:10px 0 0;font-size:12px;color:#666;">Georgia Power &nbsp;·&nbsp; Duke Energy &nbsp;·&nbsp; Dominion Energy &nbsp;·&nbsp; SDG&amp;E</p>
  </div>
  <div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px 24px;margin-bottom:20px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#aaa;margin-bottom:10px;font-weight:600;">🎧 Commute Summary — Read Aloud</div>
    <p style="margin:0;font-size:14px;color:#333;line-height:1.8;">${script}</p>
  </div>
  ${utilitySections}
  <p style="text-align:center;font-size:11px;color:#bbb;margin-top:20px;">Automated briefing · ${dateStr} · Powered by Claude</p>
</div>
</body></html>`;

  const plain = `Utility Briefing — ${dateStr}\n\n${script}\n\n---\n${allData.map(d => `${d.utility}: ${d.key_takeaway}`).join('\n')}`;
  return { html, plain };
}

// ── Send email via SMTP ────────────────────────────────────────────────────────
async function sendViaSmtp(subject, htmlBody, plainBody) {
  return new Promise((resolve, reject) => {
    const b64creds = Buffer.from(`\0${GMAIL_USER}\0${GMAIL_APP_PASS}`).toString('base64');
    const boundary = 'b' + Date.now();
    const msgBody  = [
      `From: Utility Briefing <${GMAIL_USER}>`,
      `To: ${RECIPIENTS.join(', ')}`,
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

    const rcptSteps = RECIPIENTS.map(addr => ({ wait: '250', send: `RCPT TO:<${addr}>\r\n` }));
    const conversation = [
      { wait: '220', send: `EHLO netlify.app\r\n` },
      { wait: '250', send: `AUTH PLAIN ${b64creds}\r\n` },
      { wait: '235', send: `MAIL FROM:<${GMAIL_USER}>\r\n` },
      ...rcptSteps,
      { wait: '250', send: `DATA\r\n` },
      { wait: '354', send: msgBody + '\r\n.\r\n' },
      { wait: '250', send: `QUIT\r\n` },
      { wait: '221', send: null },
    ];

    let idx = 0;
    let buf = '';
    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });

    socket.on('error', (err) => { console.error('SMTP error:', err.message); reject(err); });
    socket.on('end',   ()    => resolve({ ok: true }));
    socket.on('data',  (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        console.log('S:', line);
        const code    = line.slice(0, 3);
        const isFinal = line[3] === ' ' || line.length === 3;
        if (!isFinal) continue;
        if (idx < conversation.length && code === conversation[idx].wait) {
          const next = conversation[idx].send;
          idx++;
          if (next) { console.log('C:', next.slice(0, 60).trim()); socket.write(next); }
          else       { socket.end(); resolve({ ok: true }); }
        } else if (code.startsWith('4') || code.startsWith('5')) {
          reject(new Error('SMTP error: ' + line));
        }
      }
    });
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  console.log('Utility briefing starting...');

  if (!ANTHROPIC_KEY || !GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('Missing env vars');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  try {
    // Fetch each utility one at a time with a 15s gap — same as website
    const allData = [];
    for (let i = 0; i < UTILITIES.length; i++) {
      if (i > 0) {
        console.log('Waiting 15s before next utility...');
        await sleep(15000);
      }
      const d = await fetchUtilityData(UTILITIES[i]);
      allData.push(d);
    }

    // Generate commute script
    console.log('Generating commute script...');
    const script = await generateCommuteScript(allData, dateStr);
    console.log('Script length:', script.length, 'chars');

    // Build and send email
    const { html, plain } = buildEmail(allData, script, dateStr);
    console.log('Sending email to:', RECIPIENTS.join(', '));
    await sendViaSmtp(`⚡ Utility Briefing — ${dateStr}`, html, plain);

    console.log('Briefing sent successfully');
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch(err) {
    console.error('Briefing failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

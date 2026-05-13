const https = require('https');
const tls   = require('tls');

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;
const RECIPIENTS     = (process.env.BRIEFING_EMAIL || 'mathauer@gmail.com')
                         .split(/[,;]/).map(e => e.trim()).filter(e => e.includes('@'));

const UTILITIES = [
  'Georgia Power',
  'Duke Energy',
  'Dominion Energy',
  'San Diego Gas & Electric',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Anthropic HTTPS call ──────────────────────────────────────────────────────
function anthropicCall(payload, useWebSearch) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const headers = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(bodyStr),
    };
    if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

    const req = https.request(
      { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers },
      (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch(e) { reject(new Error('Parse error: ' + buf.slice(0, 100))); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Fetch one utility with web search + retry ─────────────────────────────────
async function fetchUtility(utility) {
  const prompt = 'Find 3 recent news items about ' + utility + '. Return ONLY valid JSON, no markdown:\n' +
    '{"utility":"' + utility + '","key_takeaway":"one sentence summary","news":[' +
    '{"headline":"...","category":"news|ma|financial|regulatory","summary":"1-2 sentences","source":"publication"}]}';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('Fetching ' + utility + ' (attempt ' + attempt + ')...');
      const data = await anthropicCall({
        model:      'claude-sonnet-4-5',
        max_tokens: 600,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages:   [{ role: 'user', content: prompt }],
      }, true);

      if (data.error) {
        if (data.error.type === 'rate_limit_error' && attempt < 3) {
          console.log('Rate limit — waiting 30s...');
          await sleep(30000);
          continue;
        }
        throw new Error(data.error.message);
      }

      const text  = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/gi, '').trim();
      const s = clean.indexOf('{');
      const e = clean.lastIndexOf('}');
      if (s === -1) throw new Error('No JSON in response');
      const parsed = JSON.parse(clean.slice(s, e + 1));
      console.log(utility + ': ' + (parsed.news || []).length + ' items');
      return parsed;

    } catch(err) {
      console.error(utility + ' error: ' + err.message);
      if (attempt === 3) return { utility: utility, key_takeaway: 'Data unavailable.', news: [] };
      await sleep(10000);
    }
  }
}

// ── Generate commute script ───────────────────────────────────────────────────
async function generateScript(allData, dateStr) {
  const summary = allData.map(d =>
    d.utility + ': ' + d.key_takeaway + '. Headlines: ' +
    (d.news || []).slice(0, 2).map(n => n.headline).join('; ') + '.'
  ).join('\n\n');

  const prompt = 'Write a spoken morning commute briefing for a utility executive. ' +
    'Conversational, ~3 min read aloud. Based on:\n' + summary + '\n\n' +
    'Start: "Good morning. Here\'s your utility briefing for ' + dateStr + '." ' +
    'Cover each partner briefly. End with one overall takeaway. No bullet points, no headers.';

  const data = await anthropicCall({
    model:      'claude-sonnet-4-5',
    max_tokens: 400,
    messages:   [{ role: 'user', content: prompt }],
  }, false);

  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildEmail(allData, script, dateStr) {
  const cats = {
    ma:         { bg: '#EEEDFE', color: '#3C3489', label: 'M&A' },
    financial:  { bg: '#E1F5EE', color: '#085041', label: 'Financial' },
    regulatory: { bg: '#FAEEDA', color: '#633806', label: 'Regulatory' },
    news:       { bg: '#E6F1FB', color: '#0C447C', label: 'News' },
  };

  const sections = allData.map(function(d) {
    const rows = (d.news || []).map(function(n) {
      const cat = cats[n.category] || cats.news;
      return '<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;">' +
        '<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">' + n.headline + '</p>' +
        '<p style="margin:0 0 5px;font-size:12px;">' +
        '<span style="background:' + cat.bg + ';color:' + cat.color + ';padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">' + cat.label + '</span>' +
        '&nbsp;' + (n.source || '') + '</p>' +
        '<p style="margin:0;font-size:13px;color:#555;line-height:1.6;">' + (n.summary || '') + '</p>' +
        '</div>';
    }).join('');
    return '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#aaa;margin-bottom:4px;">' + d.utility + '</div>' +
      '<p style="margin:0 0 14px;font-size:14px;color:#555;">' + (d.key_takeaway || '') + '</p>' +
      (rows || '<p style="color:#aaa;font-size:13px;">No items retrieved.</p>') +
      '</div>';
  }).join('');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f5f5f3;font-family:-apple-system,sans-serif;">' +
    '<div style="max-width:620px;margin:0 auto;padding:24px 16px;">' +
    '<div style="background:#1a1a1a;border-radius:10px;padding:24px 28px;margin-bottom:20px;">' +
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:6px;">Daily Intelligence Briefing</div>' +
    '<h1 style="margin:0 0 4px;font-size:22px;font-weight:600;color:#fff;">Utility Partners Update</h1>' +
    '<p style="margin:0;font-size:13px;color:#aaa;">' + dateStr + '</p>' +
    '<p style="margin:10px 0 0;font-size:12px;color:#666;">Georgia Power &nbsp;&middot;&nbsp; Duke Energy &nbsp;&middot;&nbsp; Dominion Energy &nbsp;&middot;&nbsp; SDG&amp;E</p>' +
    '</div>' +
    '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px 24px;margin-bottom:20px;">' +
    '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:10px;font-weight:600;">&#127911; Commute Summary &mdash; Read Aloud</div>' +
    '<p style="margin:0;font-size:14px;color:#333;line-height:1.8;">' + script + '</p>' +
    '</div>' +
    sections +
    '<p style="text-align:center;font-size:11px;color:#bbb;margin-top:20px;">Automated briefing &middot; ' + dateStr + ' &middot; Powered by Claude</p>' +
    '</div></body></html>';

  const plain = 'Utility Briefing - ' + dateStr + '\n\n' + script + '\n\n---\n' +
    allData.map(d => d.utility + ': ' + d.key_takeaway).join('\n');

  return { html: html, plain: plain };
}

// ── Send via Gmail SMTP ───────────────────────────────────────────────────────
function sendEmail(subject, html, plain) {
  return new Promise(function(resolve, reject) {
    var b64creds = Buffer.from('\0' + GMAIL_USER + '\0' + GMAIL_APP_PASS).toString('base64');
    var boundary = 'b' + Date.now();
    var msg = [
      'From: Utility Briefing <' + GMAIL_USER + '>',
      'To: ' + RECIPIENTS.join(', '),
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="' + boundary + '"',
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      plain,
      '',
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      '',
      html,
      '',
      '--' + boundary + '--',
    ].join('\r\n');

    var rcpt = RECIPIENTS.map(function(a) { return { wait: '250', send: 'RCPT TO:<' + a + '>\r\n' }; });
    var steps = [
      { wait: '220', send: 'EHLO netlify.app\r\n' },
      { wait: '250', send: 'AUTH PLAIN ' + b64creds + '\r\n' },
      { wait: '235', send: 'MAIL FROM:<' + GMAIL_USER + '>\r\n' },
    ].concat(rcpt).concat([
      { wait: '250', send: 'DATA\r\n' },
      { wait: '354', send: msg + '\r\n.\r\n' },
      { wait: '250', send: 'QUIT\r\n' },
      { wait: '221', send: null },
    ]);

    var idx = 0;
    var buf = '';
    var socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });

    socket.on('error', function(e) { console.error('SMTP error:', e.message); reject(e); });
    socket.on('end',   function()  { resolve({ ok: true }); });
    socket.on('data',  function(chunk) {
      buf += chunk.toString();
      var lines = buf.split('\r\n');
      buf = lines.pop();
      lines.forEach(function(line) {
        if (!line) return;
        console.log('S:', line);
        var code    = line.slice(0, 3);
        var isFinal = line[3] === ' ' || line.length === 3;
        if (!isFinal) return;
        if (idx < steps.length && code === steps[idx].wait) {
          var next = steps[idx].send;
          idx++;
          if (next) {
            console.log('C:', next.slice(0, 50).trim());
            socket.write(next);
          } else {
            socket.end();
            resolve({ ok: true });
          }
        } else if (code[0] === '4' || code[0] === '5') {
          reject(new Error('SMTP: ' + line));
        }
      });
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  console.log('Briefing starting. Recipients:', RECIPIENTS.join(', '));

  if (!ANTHROPIC_KEY || !GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('Missing env vars');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  var dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  try {
    var allData = [];
    for (var i = 0; i < UTILITIES.length; i++) {
      if (i > 0) {
        console.log('Waiting 15s...');
        await sleep(15000);
      }
      var d = await fetchUtility(UTILITIES[i]);
      allData.push(d);
    }

    console.log('Generating script...');
    var script = await generateScript(allData, dateStr);

    var email  = buildEmail(allData, script, dateStr);
    var subject = 'Utility Briefing - ' + dateStr;

    console.log('Sending to:', RECIPIENTS.join(', '));
    await sendEmail(subject, email.html, email.plain);

    console.log('Done.');
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch(err) {
    console.error('Failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

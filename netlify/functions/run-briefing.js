var https = require('https');
var tls   = require('tls');
var fs    = require('fs');

var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
var GMAIL_USER     = process.env.GMAIL_USER;
var GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;
var BRIEFING_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
var RECIPIENTS     = BRIEFING_EMAIL.split(/[,;]/).map(function(e) { return e.trim(); }).filter(function(e) { return e.indexOf('@') !== -1; });

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  CONFIGURE YOUR UTILITY PARTNERS HERE                                   │
// └─────────────────────────────────────────────────────────────────────────┘
var UTILITIES = [
  'Georgia Power',
  'Duke Energy',
  'Dominion Energy',
  'San Diego Gas & Electric',
  'American Electric Power',
  'Xcel Energy',
  'Entergy',
  'Southern California Gas',
];

// ── Anthropic call with optional web search ───────────────────────────────────
function anthropicCall(messages, maxTokens, useWebSearch) {
  return new Promise(function(resolve, reject) {
    var payload = {
      model:      'claude-sonnet-4-5',
      max_tokens: maxTokens || 2000,
      messages:   messages,
    };
    if (useWebSearch) {
      payload.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }
    var bodyStr = JSON.stringify(payload);
    var headers = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(bodyStr),
    };
    if (useWebSearch) { headers['anthropic-beta'] = 'web-search-2025-03-05'; }
    var req = https.request(
      { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: headers },
      function(res) {
        var buf = '';
        res.on('data', function(c) { buf += c; });
        res.on('end', function() {
          try { resolve(JSON.parse(buf)); }
          catch(e) { reject(new Error('Parse error: ' + buf.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function extractText(data) {
  return (data.content || [])
    .filter(function(b) { return b.type === 'text'; })
    .map(function(b) { return b.text; })
    .join('');
}

// ── Fetch live news for all utilities in one web search call ──────────────────
async function fetchLiveNews(dateStr) {
  var prompt =
    'Search for news published today or yesterday (' + dateStr + ') about these utility companies: ' +
    UTILITIES.join(', ') + '. ' +
    'Find the single most important new development for each company from the past 48 hours. ' +
    'Return ONLY a valid JSON array, starting immediately with [ and no preamble text:\n' +
    '[{"u":"Georgia Power","t":"one sentence takeaway","h":"headline","c":"news|ma|financial|regulatory"},' +
    '{"u":"Duke Energy","t":"...","h":"...","c":"..."},' +
    '{"u":"Dominion Energy","t":"...","h":"...","c":"..."},' +
    '{"u":"San Diego Gas & Electric","t":"...","h":"...","c":"..."},' +
    '{"u":"American Electric Power","t":"...","h":"...","c":"..."},' +
    '{"u":"Xcel Energy","t":"...","h":"...","c":"..."},' +
    '{"u":"Entergy","t":"...","h":"...","c":"..."},' +
    '{"u":"Southern California Gas","t":"...","h":"...","c":"..."}]';

  console.log('Fetching live news via web search...');
  var data = await anthropicCall([{ role: 'user', content: prompt }], 2000, true);

  if (data.error) {
    console.error('Web search error: ' + data.error.message);
    return [];
  }

  var text = extractText(data);
  console.log('Web search response: ' + text.length + ' chars, stop_reason: ' + data.stop_reason);

  var clean = text.replace(/```json|```/gi, '').trim();
  var s = clean.indexOf('['), e = clean.lastIndexOf(']');
  if (s === -1) {
    console.error('No JSON array found. Sample: ' + clean.slice(0, 300));
    return [];
  }
  try {
    var parsed = JSON.parse(clean.slice(s, e + 1));
    console.log('Parsed ' + parsed.length + ' utility items');
    return parsed;
  } catch(err) {
    console.error('JSON parse error: ' + err.message + '. Sample: ' + clean.slice(s, s + 300));
    return [];
  }
}

// ── Generate commute script ───────────────────────────────────────────────────
async function generateScript(items, dateStr) {
  var summary = items.map(function(x) {
    return (x.u || x.utility) + ': ' + (x.t || x.takeaway || 'No update') + '. ' + (x.h || x.headline || '');
  }).join(' ');

  var prompt =
    'Write a spoken commute briefing for ' + dateStr + ' covering only the NEW developments listed. ' +
    'Write a SEPARATE paragraph for each utility — start each paragraph with the utility name in bold using <b>Utility Name</b> format. ' +
    'Begin with: Good morning, here is your utility briefing for ' + dateStr + '. ' +
    'After all utilities, add a final Overall Takeaway paragraph. ' +
    'No bullet points. Natural spoken language. Based on:\n' + summary;

  var data = await anthropicCall([{ role: 'user', content: prompt }], 1200, false);
  return extractText(data);
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildEmail(items, script, dateStr) {
  var catBg    = { ma: '#EEEDFE', financial: '#E1F5EE', regulatory: '#FAEEDA', news: '#E6F1FB' };
  var catColor = { ma: '#3C3489', financial: '#085041', regulatory: '#633806', news: '#0C447C' };
  var catLabel = { ma: 'M&A', financial: 'Financial', regulatory: 'Regulatory', news: 'News' };

  var sections = UTILITIES.map(function(u, i) {
    var x = items[i] || {};
    var c = x.c || x.category || 'news';
    var rows =
      '<div style="padding:10px 0;">' +
      '<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">' + (x.h || x.headline || 'No headline today') + '</p>' +
      '<span style="background:' + (catBg[c]||catBg.news) + ';color:' + (catColor[c]||catColor.news) + ';padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">' + (catLabel[c]||'News') + '</span>' +
      '<p style="margin:6px 0 0;font-size:13px;color:#555;line-height:1.6;">' + (x.t || x.takeaway || '') + '</p></div>';

    return '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">' +
      '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:4px;">' + u + '</div>' +
      '<p style="margin:0 0 12px;font-size:14px;color:#555;">' + (x.t || x.takeaway || 'No update available.') + '</p>' +
      rows + '</div>';
  }).join('');

  var scriptHtml = script.split('\n\n').map(function(p) {
    return p.trim() ? '<p style="margin:0 0 14px;">' + p.trim() + '</p>' : '';
  }).join('');

  var html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f5f5f3;font-family:sans-serif;">' +
    '<div style="max-width:620px;margin:0 auto;padding:24px 16px;">' +
    '<div style="background:#1a1a1a;border-radius:10px;padding:24px;margin-bottom:20px;">' +
    '<h1 style="margin:0 0 4px;font-size:22px;color:#fff;">Utility Partners Update</h1>' +
    '<p style="margin:0;font-size:13px;color:#aaa;">' + dateStr + '</p></div>' +
    '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:20px;">' +
    '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:8px;">Commute Summary</div>' +
    '<div style="font-size:14px;color:#333;line-height:1.8;">' + scriptHtml + '</div></div>' +
    sections +
    '<p style="text-align:center;font-size:11px;color:#bbb;margin-top:20px;">Automated briefing - ' + dateStr + '</p>' +
    '</div></body></html>';

  var plain = 'Utility Briefing - ' + dateStr + '\n\n' + script + '\n\n' +
    items.map(function(x) { return (x.u||x.utility) + ': ' + (x.t||x.takeaway||''); }).join('\n');

  return { html: html, plain: plain };
}

// ── Send via Gmail SMTP ───────────────────────────────────────────────────────
function sendEmail(subject, html, plain) {
  return new Promise(function(resolve, reject) {
    var b64  = Buffer.from('\0' + GMAIL_USER + '\0' + GMAIL_APP_PASS).toString('base64');
    var bnd  = 'b' + Date.now();
    var msg  =
      'From: Utility Briefing <' + GMAIL_USER + '>\r\n' +
      'To: ' + RECIPIENTS.join(', ') + '\r\n' +
      'Subject: ' + subject + '\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: multipart/alternative; boundary="' + bnd + '"\r\n\r\n' +
      '--' + bnd + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + plain + '\r\n\r\n' +
      '--' + bnd + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n\r\n' +
      '--' + bnd + '--';
    var rcpt  = RECIPIENTS.map(function(a) { return { w: '250', s: 'RCPT TO:<' + a + '>\r\n' }; });
    var steps = [
      { w: '220', s: 'EHLO netlify.app\r\n' },
      { w: '250', s: 'AUTH PLAIN ' + b64 + '\r\n' },
      { w: '235', s: 'MAIL FROM:<' + GMAIL_USER + '>\r\n' },
    ].concat(rcpt).concat([
      { w: '250', s: 'DATA\r\n' },
      { w: '354', s: msg + '\r\n.\r\n' },
      { w: '250', s: 'QUIT\r\n' },
      { w: '221', s: null },
    ]);
    var idx = 0, buf = '';
    var sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    sock.on('error', function(e) { reject(e); });
    sock.on('end',   function()  { resolve(true); });
    sock.on('data',  function(chunk) {
      buf += chunk.toString();
      var lines = buf.split('\r\n'); buf = lines.pop();
      lines.forEach(function(line) {
        if (!line) { return; }
        var code = line.slice(0,3), fin = (line[3]===' '||line.length===3);
        if (!fin) { return; }
        console.log('SMTP ' + code);
        if (idx < steps.length && code === steps[idx].w) {
          var next = steps[idx].s; idx++;
          if (next) { sock.write(next); } else { sock.end(); resolve(true); }
        } else if (code[0]==='4'||code[0]==='5') { reject(new Error('SMTP: ' + line)); }
      });
    });
  });
}

// ── Main handler (scheduled) ──────────────────────────────────────────────────
exports.handler = async function(event) {
  var params   = (event.queryStringParameters || {});
  var forced   = params.force === 'true';
  var today    = new Date().toISOString().slice(0, 10);
  var lockFile = '/tmp/briefing_' + today + '.lock';

  if (!forced && fs.existsSync(lockFile)) {
    console.log('Already ran today - skipping.');
    return { statusCode: 200, body: 'Already sent today.' };
  }
  fs.writeFileSync(lockFile, new Date().toISOString());
  if (forced) { console.log('Force override active.'); }
  console.log('START date=' + today + ' recipients=' + RECIPIENTS.join(','));

  var dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  try {
    // Step 1: fetch live news via web search
    var items = await fetchLiveNews(dateStr);

    if (!items || items.length === 0) {
      try { fs.unlinkSync(lockFile); } catch(e) {}
      console.error('No news items returned');
      return { statusCode: 500, body: 'No content retrieved' };
    }

    // Step 2: generate commute script
    console.log('Generating commute script...');
    var script = await generateScript(items, dateStr);

    // Step 3: build and send email
    var email = buildEmail(items, script, dateStr);
    console.log('Sending email to: ' + RECIPIENTS.join(', '));
    await sendEmail('Utility Briefing - ' + dateStr, email.html, email.plain);
    console.log('Done. ' + items.length + ' utilities covered.');
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch(err) {
    try { fs.unlinkSync(lockFile); } catch(e) {}
    console.error('FAILED: ' + err.message);
    return { statusCode: 500, body: err.message };
  }
};

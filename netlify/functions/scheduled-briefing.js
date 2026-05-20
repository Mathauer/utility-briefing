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

// ── Anthropic API call (no web search) ───────────────────────────────────────
function anthropicCall(messages, maxTokens) {
  return new Promise(function(resolve, reject) {
    var payload = {
      model:      'claude-sonnet-4-5',
      max_tokens: maxTokens || 2000,
      messages:   messages,
    };
    var bodyStr = JSON.stringify(payload);
    var headers = {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(bodyStr),
    };
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
  return (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
}

// ── Generate full briefing in one call ────────────────────────────────────────
async function generateBriefing(dateStr) {
  var utilList = UTILITIES.join(', ');
  var prompt =
    'You are preparing a daily intelligence briefing dated ' + dateStr + ' for a utility industry executive.\n\n' +
    'For each of these utility companies: ' + utilList + '\n\n' +
    'Provide 2 concise news items per utility covering recent news, M&A, financials, or regulatory updates. ' +
    'Provide exactly 1-2 news items per utility. Keep summaries to 1 sentence each.\n\n' +
    'Then write a 3-minute spoken commute script summarizing everything.\n\n' +
    'Return ONLY valid JSON in exactly this format, starting with { and no preamble:\n' +
    '{\n' +
    '  "utilities": [\n' +
    '    {"utility":"Georgia Power","key_takeaway":"one sentence","news":[{"headline":"...","category":"news|ma|financial|regulatory","summary":"2-3 sentences","source":""}]},\n' +
    '    {"utility":"Duke Energy","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"Dominion Energy","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"San Diego Gas & Electric","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"American Electric Power","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"Xcel Energy","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"Entergy","key_takeaway":"...","news":[...]},\n' +
    '    {"utility":"Southern California Gas","key_takeaway":"...","news":[...]}\n' +
    '  ],\n' +
    '  "commute_script": "Good morning. Here\'s your utility briefing for ' + dateStr + '. [3 minute spoken summary covering all 8 utilities with one overall takeaway at the end.]"\n' +
    '}';

  console.log('Calling Claude for briefing...');
  var data = await anthropicCall([{ role: 'user', content: prompt }], 8000);

  if (data.error) {
    console.error('API error: ' + data.error.message);
    return null;
  }

  var text = extractText(data);
  console.log('Response: ' + text.length + ' chars, stop_reason: ' + data.stop_reason);

  var clean = text.replace(/```json|```/gi, '').trim();
  var s = clean.indexOf('{');
  var e = clean.lastIndexOf('}');
  if (s === -1) {
    console.error('No JSON found. Sample: ' + clean.slice(0, 200));
    return null;
  }
  try {
    var parsed = JSON.parse(clean.slice(s, e + 1));
    console.log('Parsed ' + (parsed.utilities || []).length + ' utilities');
    return parsed;
  } catch(err) {
    console.error('JSON parse error: ' + err.message + '. Sample: ' + clean.slice(s, s + 300));
    return null;
  }
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildEmail(result, dateStr) {
  var allData = result.utilities || [];
  var script  = result.commute_script || '';
  var catBg    = { ma: '#EEEDFE', financial: '#E1F5EE', regulatory: '#FAEEDA', news: '#E6F1FB' };
  var catColor = { ma: '#3C3489', financial: '#085041', regulatory: '#633806', news: '#0C447C' };
  var catLabel = { ma: 'M&A',     financial: 'Financial', regulatory: 'Regulatory', news: 'News' };

  var sections = allData.map(function(d) {
    var rows = (d.news || []).map(function(n) {
      var c = n.category || 'news';
      return '<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;">' +
        '<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">' + (n.headline||'') + '</p>' +
        '<span style="background:' + (catBg[c]||catBg.news) + ';color:' + (catColor[c]||catColor.news) + ';padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">' + (catLabel[c]||'News') + '</span>' +
        ' <span style="font-size:12px;color:#888;">' + (n.source||'') + '</span>' +
        '<p style="margin:6px 0 0;font-size:13px;color:#555;line-height:1.6;">' + (n.summary||'') + '</p></div>';
    }).join('');
    return '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">' +
      '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:4px;">' + d.utility + '</div>' +
      '<p style="margin:0 0 12px;font-size:14px;color:#555;">' + (d.key_takeaway||'') + '</p>' +
      (rows || '<p style="color:#aaa;font-size:13px;">No items.</p>') + '</div>';
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
    '<p style="margin:0;font-size:14px;color:#333;line-height:1.8;">' + script + '</p></div>' +
    sections +
    '<p style="text-align:center;font-size:11px;color:#bbb;margin-top:20px;">Automated briefing - ' + dateStr + '</p>' +
    '</div></body></html>';

  var plain = 'Utility Briefing - ' + dateStr + '\n\n' + script + '\n\n' +
    allData.map(function(d) { return d.utility + ': ' + d.key_takeaway; }).join('\n');
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
        var code = line.slice(0, 3), fin = (line[3] === ' ' || line.length === 3);
        if (!fin) { return; }
        console.log('SMTP ' + code);
        if (idx < steps.length && code === steps[idx].w) {
          var next = steps[idx].s; idx++;
          if (next) { sock.write(next); } else { sock.end(); resolve(true); }
        } else if (code[0] === '4' || code[0] === '5') {
          reject(new Error('SMTP: ' + line));
        }
      });
    });
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
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
    var result = await generateBriefing(dateStr);

    if (!result || !(result.utilities || []).length) {
      try { fs.unlinkSync(lockFile); } catch(e) {}
      return { statusCode: 500, body: 'No content retrieved' };
    }

    var successCount = (result.utilities || []).filter(function(d) { return d.news && d.news.length > 0; }).length;
    console.log('Utilities with content: ' + successCount + '/' + UTILITIES.length);

    var email = buildEmail(result, dateStr);
    console.log('Sending email...');
    await sendEmail('Utility Briefing - ' + dateStr, email.html, email.plain);
    console.log('Done. ' + successCount + '/' + UTILITIES.length + ' utilities populated.');
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch(err) {
    try { fs.unlinkSync(lockFile); } catch(e) {}
    console.error('FAILED: ' + err.message);
    return { statusCode: 500, body: err.message };
  }
};

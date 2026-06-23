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

// ── Generate briefing — two fast calls ───────────────────────────────────────
async function generateBriefing(dateStr) {
  // Call 1: short utility summaries
  var prompt1 =
    'For each of these utilities give ONE key headline and one-sentence takeaway from recent news. ' +
    'Utilities: ' + UTILITIES.join(', ') + '. ' +
    'Return ONLY this JSON array, no preamble, no markdown: ' +
    '[{"u":"Georgia Power","t":"takeaway","h":"headline","c":"news"},{"u":"Duke Energy","t":"...","h":"...","c":"..."},...]';

  console.log('Call 1: summaries...');
  var d1 = await anthropicCall([{ role: 'user', content: prompt1 }], 1500);
  if (d1.error) { console.error('Call 1 error: ' + d1.error.message); return null; }

  var t1 = extractText(d1);
  console.log('Call 1: ' + t1.length + ' chars, stop: ' + d1.stop_reason);
  var c1 = t1.replace(/```json|```/gi,'').trim();
  var s1 = c1.indexOf('['), e1 = c1.lastIndexOf(']');
  var items = [];
  if (s1 !== -1) { try { items = JSON.parse(c1.slice(s1, e1+1)); } catch(e) { console.error('Call 1 parse: ' + e.message); } }
  console.log('Call 1: ' + items.length + ' items parsed');

  // Call 2: commute script
  var summary = items.map(function(x) { return x.u + ': ' + x.t + '. ' + x.h; }).join(' ');
  var commutePrompt = 'Write a spoken commute briefing for ' + dateStr + '. Write a SEPARATE paragraph for each utility — start each paragraph with the utility name in bold using <b>Utility Name</b> format. Begin with: Good morning, here is your utility briefing for ' + dateStr + '. After all utilities, add a final Overall Takeaway paragraph. No bullet points. Based on: ' + summary;
  var d2 = await anthropicCall([{ role: 'user', content: commutePrompt }], 1200);
  var script = extractText(d2);
  console.log('Call 2: ' + script.length + ' chars');

  var utilities = UTILITIES.map(function(u, i) {
    var x = items[i] || {};
    return {
      utility:      u,
      key_takeaway: x.t || 'No data available.',
      news: [{ headline: x.h || 'Recent developments', category: x.c || 'news', summary: x.t || '', source: '' }],
    };
  });

  return { utilities: utilities, commute_script: script };
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
    '<div style="font-size:14px;color:#333;line-height:1.8;">' + script.split('\n\n').map(function(p) { return p.trim() ? '<p style="margin:0 0 14px;">' + p.trim() + '</p>' : ''; }).join('') + '</div></div>' +
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

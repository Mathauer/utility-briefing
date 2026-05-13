var https = require('https');
var tls   = require('tls');

var ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
var GMAIL_USER     = process.env.GMAIL_USER;
var GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;
var BRIEFING_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
var RECIPIENTS     = BRIEFING_EMAIL.split(/[,;]/).map(function(e) { return e.trim(); }).filter(function(e) { return e.indexOf('@') !== -1; });

var UTILITIES = ['Georgia Power','Duke Energy','Dominion Energy','San Diego Gas & Electric'];

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function anthropicCall(payload, useWebSearch, cb) {
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
      res.on('end', function() { try { cb(null, JSON.parse(buf)); } catch(e) { cb(e); } });
    }
  );
  req.on('error', cb);
  req.write(bodyStr);
  req.end();
}

function callAnthropic(payload, useWebSearch) {
  return new Promise(function(resolve, reject) {
    anthropicCall(payload, useWebSearch, function(err, data) {
      if (err) { reject(err); } else { resolve(data); }
    });
  });
}

function extractText(data) {
  return (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
}

function parseJSON(text) {
  var clean = text.replace(/```json|```/gi, '').trim();
  var s = clean.indexOf('{');
  var e = clean.lastIndexOf('}');
  if (s === -1) { return null; }
  return JSON.parse(clean.slice(s, e + 1));
}

async function fetchUtility(utility) {
  var prompt = 'Find 3 recent news items about ' + utility + '. Return ONLY valid JSON, no markdown: ' +
    '{"utility":"' + utility + '","key_takeaway":"one sentence","news":[{"headline":"...","category":"news","summary":"1-2 sentences","source":"..."}]}';
  var payload = { model: 'claude-sonnet-4-5', max_tokens: 600, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: prompt }] };
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log('Fetching ' + utility + ' attempt ' + attempt);
      var data = await callAnthropic(payload, true);
      if (data.error) {
        if (data.error.type === 'rate_limit_error') {
          console.log('Rate limit on ' + utility + ' — waiting 65s');
          await sleep(65000);
          continue;
        }
        throw new Error(data.error.message);
      }
      var text = extractText(data);
      var parsed = parseJSON(text);
      if (!parsed) { return { utility: utility, key_takeaway: 'No data.', news: [] }; }
      console.log('Got ' + utility + ': ' + (parsed.news||[]).length + ' items');
      return parsed;
    } catch(err) {
      console.error(utility + ' attempt ' + attempt + ' failed: ' + err.message);
      if (attempt === 3) { return { utility: utility, key_takeaway: 'Data unavailable.', news: [] }; }
      await sleep(10000);
    }
  }
  return { utility: utility, key_takeaway: 'Data unavailable.', news: [] };
}

function generateScript(allData, dateStr) {
  var summary = allData.map(function(d) {
    return d.utility + ': ' + d.key_takeaway;
  }).join('. ');
  var prompt = 'Write a 3-minute spoken commute briefing for a utility executive. Start: "Good morning. Here\'s your utility briefing for ' + dateStr + '." Based on: ' + summary + '. No bullet points.';
  return callAnthropic({ model: 'claude-sonnet-4-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }, false)
    .then(function(data) { return extractText(data); });
}

function buildHTML(allData, script, dateStr) {
  var cats = { ma: '#3C3489', financial: '#085041', regulatory: '#633806', news: '#0C447C' };
  var catBg = { ma: '#EEEDFE', financial: '#E1F5EE', regulatory: '#FAEEDA', news: '#E6F1FB' };
  var catLabel = { ma: 'M&A', financial: 'Financial', regulatory: 'Regulatory', news: 'News' };

  var sections = allData.map(function(d) {
    var rows = (d.news || []).map(function(n) {
      var c = n.category || 'news';
      return '<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;">' +
        '<p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">' + (n.headline || '') + '</p>' +
        '<span style="background:' + (catBg[c]||catBg.news) + ';color:' + (cats[c]||cats.news) + ';padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;">' + (catLabel[c]||'News') + '</span>' +
        '&nbsp;<span style="font-size:12px;color:#888;">' + (n.source || '') + '</span>' +
        '<p style="margin:6px 0 0;font-size:13px;color:#555;line-height:1.6;">' + (n.summary || '') + '</p></div>';
    }).join('');
    return '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:16px;">' +
      '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:4px;">' + d.utility + '</div>' +
      '<p style="margin:0 0 12px;font-size:14px;color:#555;">' + (d.key_takeaway || '') + '</p>' +
      (rows || '<p style="color:#aaa;font-size:13px;">No items.</p>') + '</div>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f5f5f3;font-family:sans-serif;">' +
    '<div style="max-width:620px;margin:0 auto;padding:24px 16px;">' +
    '<div style="background:#1a1a1a;border-radius:10px;padding:24px;margin-bottom:20px;">' +
    '<h1 style="margin:0 0 4px;font-size:22px;color:#fff;">Utility Partners Update</h1>' +
    '<p style="margin:0;font-size:13px;color:#aaa;">' + dateStr + '</p></div>' +
    '<div style="background:#fff;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:20px;">' +
    '<div style="font-size:10px;text-transform:uppercase;color:#aaa;margin-bottom:8px;">Commute Summary</div>' +
    '<p style="margin:0;font-size:14px;color:#333;line-height:1.8;">' + script + '</p></div>' +
    sections + '</div></body></html>';
}

function sendEmail(subject, html, plain) {
  return new Promise(function(resolve, reject) {
    var b64 = Buffer.from('\0' + GMAIL_USER + '\0' + GMAIL_APP_PASS).toString('base64');
    var bnd = 'b' + Date.now();
    var msg = 'From: Utility Briefing <' + GMAIL_USER + '>\r\n' +
      'To: ' + RECIPIENTS.join(', ') + '\r\n' +
      'Subject: ' + subject + '\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: multipart/alternative; boundary="' + bnd + '"\r\n\r\n' +
      '--' + bnd + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + plain + '\r\n\r\n' +
      '--' + bnd + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n\r\n' +
      '--' + bnd + '--';

    var rcpt = RECIPIENTS.map(function(a) { return { w: '250', s: 'RCPT TO:<' + a + '>\r\n' }; });
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

    var idx = 0;
    var buf = '';
    var sock = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    sock.on('error', function(e) { reject(e); });
    sock.on('end',   function()  { resolve(true); });
    sock.on('data',  function(chunk) {
      buf += chunk.toString();
      var lines = buf.split('\r\n');
      buf = lines.pop();
      lines.forEach(function(line) {
        if (!line) { return; }
        var code = line.slice(0, 3);
        var fin  = (line[3] === ' ' || line.length === 3);
        if (!fin) { return; }
        console.log('SMTP ' + code);
        if (idx < steps.length && code === steps[idx].w) {
          var next = steps[idx].s;
          idx++;
          if (next) { sock.write(next); }
          else { sock.end(); resolve(true); }
        } else if (code[0] === '4' || code[0] === '5') {
          reject(new Error('SMTP: ' + line));
        }
      });
    });
  });
}

exports.handler = async function(event) {
  console.log('START recipients=' + RECIPIENTS.join(','));
  try {
    var dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    var allData = [];
    for (var i = 0; i < UTILITIES.length; i++) {
      if (i > 0) { await sleep(20000); }
      var d = await fetchUtility(UTILITIES[i]);
      allData.push(d);
      console.log('Got ' + d.utility);
    }
    var script = await generateScript(allData, dateStr);
    console.log('Script ok');
    var html  = buildHTML(allData, script, dateStr);
    var plain = 'Utility Briefing - ' + dateStr + '\n\n' + script;
    await sendEmail('Utility Briefing - ' + dateStr, html, plain);
    console.log('Email sent');
    return { statusCode: 200, body: 'Briefing sent successfully' };
  } catch(err) {
    console.error('FAILED: ' + err.message);
    return { statusCode: 500, body: err.message };
  }
};

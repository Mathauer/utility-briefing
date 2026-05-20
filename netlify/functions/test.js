var https = require('https');

var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function anthropicRequest(payload, useWebSearch) {
  return new Promise(function(resolve, reject) {
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

exports.handler = async function(event) {
  try {
    // Simple test — ask for ONE utility in JSON format, no web search
    var data = await anthropicRequest({
      model:      'claude-sonnet-4-5',
      max_tokens: 400,
      messages:   [{ role: 'user', content:
        'Return ONLY a valid JSON array, no markdown, no extra text:\n' +
        '[{"utility":"Georgia Power","key_takeaway":"test","news":[{"headline":"test headline","category":"news","summary":"test summary","source":"test"}]}]'
      }],
    }, false);

    var text = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');

    // Try parsing
    var clean = text.replace(/```json|```/gi, '').trim();
    var s = clean.indexOf('[');
    var e = clean.lastIndexOf(']');
    var parsed = null;
    var parseError = null;
    if (s !== -1) {
      try { parsed = JSON.parse(clean.slice(s, e + 1)); }
      catch(err) { parseError = err.message; }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        stop_reason:  data.stop_reason,
        error:        data.error || null,
        text_length:  text.length,
        text_sample:  text.slice(0, 300),
        found_array:  s !== -1,
        parse_ok:     parsed !== null,
        parse_error:  parseError,
        item_count:   parsed ? parsed.length : 0,
      }, null, 2),
    };
  } catch(err) {
    return { statusCode: 200, body: JSON.stringify({ crashed: err.message }) };
  }
};

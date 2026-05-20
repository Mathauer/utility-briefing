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
          catch(e) { reject(new Error('Parse: ' + buf.slice(0, 200))); }
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
    // Step 1: web search call for just ONE utility
    var messages = [{ role: 'user', content:
      'Search for 1 recent news item about Georgia Power utility. ' +
      'Return ONLY valid JSON, no markdown:\n' +
      '[{"utility":"Georgia Power","key_takeaway":"one sentence","news":[{"headline":"...","category":"news","summary":"1-2 sentences","source":"..."}]}]'
    }];

    var payload = {
      model:      'claude-sonnet-4-5',
      max_tokens: 600,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   messages,
    };

    var data = await anthropicRequest(payload, true);
    var round1_stop = data.stop_reason;
    var round1_types = (data.content || []).map(function(b) { return b.type; });

    // If tool_use, do one more round
    var round2_stop = null;
    var finalText = '';

    if (data.stop_reason === 'tool_use') {
      var toolResults = (data.content || [])
        .filter(function(b) { return b.type === 'tool_use'; })
        .map(function(b) { return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(b.input || {}) }; });

      payload.messages = messages.concat([
        { role: 'assistant', content: data.content },
        { role: 'user',      content: toolResults  },
      ]);

      data = await anthropicRequest(payload, true);
      round2_stop = data.stop_reason;
    }

    finalText = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');

    // Try parse
    var clean = finalText.replace(/```json|```/gi, '').trim();
    var s = clean.indexOf('[');
    var e = clean.lastIndexOf(']');
    var parsed = null;
    var parseErr = null;
    if (s !== -1) {
      try { parsed = JSON.parse(clean.slice(s, e + 1)); }
      catch(err) { parseErr = err.message; }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        round1_stop:  round1_stop,
        round1_types: round1_types,
        round2_stop:  round2_stop,
        text_length:  finalText.length,
        text_sample:  finalText.slice(0, 400),
        found_array:  s !== -1,
        parse_ok:     parsed !== null,
        parse_error:  parseErr,
        item_count:   parsed ? parsed.length : 0,
      }, null, 2),
    };
  } catch(err) {
    return { statusCode: 200, body: JSON.stringify({ crashed: err.message }) };
  }
};

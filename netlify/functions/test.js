const https = require('https');
const tls   = require('tls');

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
          catch(e) { reject(new Error('Parse error: ' + buf.slice(0,100))); }
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
    console.log('Step 1: basic setup ok');

    // Test one small Anthropic call with web search
    const data = await anthropicCall({
      model:      'claude-sonnet-4-5',
      max_tokens: 100,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
    }, true);

    console.log('Step 2: anthropic call complete, stop_reason:', data.stop_reason);
    console.log('Step 2: error:', data.error ? data.error.message : 'none');

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    console.log('Step 3: text extracted:', text.slice(0, 100));

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        stop_reason: data.stop_reason,
        error: data.error || null,
        text: text || null,
        content_types: (data.content || []).map(b => b.type),
      })
    };
  } catch(err) {
    console.error('Crashed:', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

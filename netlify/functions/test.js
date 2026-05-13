const https = require('https');
const tls   = require('tls');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;
const RECIPIENTS     = (process.env.BRIEFING_EMAIL || 'mathauer@gmail.com')
                         .split(/[,;]/).map(e => e.trim()).filter(e => e.includes('@'));

exports.handler = async function(event) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      node: process.version,
      recipients: RECIPIENTS,
      hasAnthropicKey: !!ANTHROPIC_KEY,
      hasGmailUser: !!GMAIL_USER,
      hasGmailPass: !!GMAIL_APP_PASS,
    })
  };
};

const nodemailer = require('nodemailer');

// ── Configuration ─────────────────────────────────────────────────────────────
const UTILITIES = [
  'Georgia Power',
  'Duke Energy',
  'Dominion Energy',
  'San Diego Gas & Electric',
];

const RECIPIENT_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
const GMAIL_USER      = process.env.GMAIL_USER;
const GMAIL_APP_PASS  = process.env.GMAIL_APP_PASSWORD;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

// ── Helper: call Anthropic API ─────────────────────────────────────────────────
async function callAnthropic(body, useWebSearch = false) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ── Helper: sleep ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Fetch news for one utility ────────────────────────────────────────────────
async function fetchUtilityData(utility) {
  const data = await callAnthropic({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `Find 3 recent news items about ${utility}. Return ONLY valid JSON, no markdown:
{"utility":"${utility}","key_takeaway":"one sentence summary","news":[{"headline":"...","category":"news|ma|financial|regulatory","summary":"1-2 sentences","source":"publication"}]}`,
    }],
  }, true);

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return { utility, key_takeaway: 'Data temporarily unavailable.', news: [] };
  }
}

// ── Generate commute script ───────────────────────────────────────────────────
async function generateScript(allData, dateStr) {
  const summary = allData.map(d =>
    `${d.utility}: ${d.key_takeaway}. Headlines: ${(d.news || []).slice(0, 2).map(n => n.headline).join('; ')}.`
  ).join('\n\n');

  const data = await callAnthropic({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Write a spoken morning commute briefing for a utility executive. Conversational, ~3 min read aloud. Based on:\n${summary}\n\nStart: "Good morning. Here's your utility briefing for ${dateStr}." Cover each partner briefly. End with one overall takeaway. No bullet points, no headers.`,
    }],
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

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(subject, html, plain) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
  });

  await transporter.sendMail({
    from: `Utility Briefing <${GMAIL_USER}>`,
    to: RECIPIENT_EMAIL,
    subject,
    text: plain,
    html,
  });
}

// ── Main scheduled handler ────────────────────────────────────────────────────
const handler = async function() {
  console.log('Utility briefing starting...');

  if (!ANTHROPIC_KEY || !GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('Missing required environment variables');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  try {
    // Fetch each utility with a 120-second gap to stay under rate limits
    const allData = [];
    for (let i = 0; i < UTILITIES.length; i++) {
      console.log(`Fetching: ${UTILITIES[i]}...`);
      if (i > 0) await sleep(15000); // 15s gap — background function allows up to 15 min
      const data = await fetchUtilityData(UTILITIES[i]);
      allData.push(data);
      console.log(`Done: ${UTILITIES[i]}`);
    }

    // Generate commute script
    console.log('Generating commute script...');
    const script = await generateScript(allData, dateStr);

    // Build and send email
    console.log('Sending email...');
    const { html, plain } = buildEmail(allData, script, dateStr);
    await sendEmail(`⚡ Utility Briefing — ${dateStr}`, html, plain);

    console.log(`Briefing sent to ${RECIPIENT_EMAIL}`);
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch (err) {
    console.error('Briefing failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = handler;

const nodemailer = require('nodemailer');
const { schedule } = require('@netlify/functions');

const RECIPIENT_EMAIL = process.env.BRIEFING_EMAIL || 'mathauer@gmail.com';
const GMAIL_USER      = process.env.GMAIL_USER;
const GMAIL_APP_PASS  = process.env.GMAIL_APP_PASSWORD;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const NEWS_API_KEY    = process.env.NEWS_API_KEY || '';

const UTILITIES = [
  { name: 'Georgia Power',              query: 'Georgia Power utility' },
  { name: 'Duke Energy',                query: 'Duke Energy utility' },
  { name: 'Dominion Energy',            query: 'Dominion Energy utility' },
  { name: 'San Diego Gas & Electric',   query: 'San Diego Gas Electric SDG&E' },
];

// ── Fetch headlines from NewsAPI (free tier) ───────────────────────────────────
async function fetchNewsHeadlines(query) {
  if (!NEWS_API_KEY) return [];
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&language=en&apiKey=${NEWS_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return (data.articles || []).map(a => ({
      headline: a.title,
      source: a.source?.name || '',
      url: a.url,
    }));
  } catch(e) {
    console.error('NewsAPI error:', e.message);
    return [];
  }
}

// ── Ask Claude to write briefing using live headlines ──────────────────────────
async function generateBriefing(headlinesByUtility, dateStr) {
  // Build a context block of raw headlines for Claude to work from
  const context = UTILITIES.map(u => {
    const headlines = headlinesByUtility[u.name] || [];
    const headlineText = headlines.length
      ? headlines.map(h => `- ${h.headline} (${h.source})`).join('\n')
      : '- No headlines available today';
    return `${u.name}:\n${headlineText}`;
  }).join('\n\n');

  console.log('Sending to Claude for analysis...');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are preparing a daily intelligence briefing for an executive who works with these utility partners: Georgia Power, Duke Energy, Dominion Energy, and San Diego Gas & Electric.

Here are today's news headlines for each utility:

${context}

Please do two things:

1. For each utility, write a JSON summary with a key_takeaway and 2-3 news items with analysis. Categories: news, ma, financial, regulatory.

2. Write a spoken commute briefing script (~3 minutes read aloud). Start with "Good morning. Here's your utility briefing for ${dateStr}." Natural spoken language, no bullet points.

Return ONLY valid JSON in this exact format, no markdown:
{
  "utilities": [
    {"utility":"Georgia Power","key_takeaway":"one sentence","news":[{"headline":"...","category":"news","summary":"1-2 sentence analysis","source":"..."}]},
    {"utility":"Duke Energy","key_takeaway":"...","news":[...]},
    {"utility":"Dominion Energy","key_takeaway":"...","news":[...]},
    {"utility":"San Diego Gas & Electric","key_takeaway":"...","news":[...]}
  ],
  "commute_script": "Good morning. Here's your utility briefing for ${dateStr}. ..."
}`,
      }],
    }),
  });

  const data = await resp.json();
  if (data.error) {
    console.error('Claude error:', JSON.stringify(data.error));
    return null;
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  console.log('Claude response length:', text.length, 'chars');

  const clean = text.replace(/```json|```/gi, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start === -1) {
    console.error('No JSON in Claude response. Sample:', text.slice(0, 200));
    return null;
  }
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch(e) {
    console.error('JSON parse error:', e.message, clean.slice(0, 200));
    return null;
  }
}

// ── Build HTML email ──────────────────────────────────────────────────────────
function buildEmail(result, dateStr) {
  const allData = result.utilities || [];
  const script  = result.commute_script || 'Commute script unavailable.';

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

// ── Main handler ──────────────────────────────────────────────────────────────
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
    // Step 1: Fetch headlines from NewsAPI for each utility
    console.log('Fetching news headlines...');
    const headlinesByUtility = {};
    for (const u of UTILITIES) {
      headlinesByUtility[u.name] = await fetchNewsHeadlines(u.query);
      console.log(`${u.name}: ${headlinesByUtility[u.name].length} headlines`);
    }

    // Step 2: Send headlines to Claude for analysis and script writing
    const result = await generateBriefing(headlinesByUtility, dateStr);

    if (!result) {
      throw new Error('Failed to generate briefing content from Claude');
    }

    console.log(`Got ${(result.utilities || []).length} utility summaries`);

    // Step 3: Build and send email
    const { html, plain } = buildEmail(result, dateStr);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
    });

    await transporter.sendMail({
      from: `Utility Briefing <${GMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      subject: `⚡ Utility Briefing — ${dateStr}`,
      text: plain,
      html,
    });

    console.log(`Briefing sent to ${RECIPIENT_EMAIL}`);
    return { statusCode: 200, body: 'Briefing sent successfully' };

  } catch (err) {
    console.error('Briefing failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = schedule('30 10 * * 1-5', handler);

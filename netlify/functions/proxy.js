exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
 
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set' })
    };
  }
 
  try {
    const body = JSON.parse(event.body);
 
    // Helper to call Anthropic once
    async function callAnthropic(payload) {
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      };
      if (payload.tools) {
        headers['anthropic-beta'] = 'web-search-2025-03-05';
      }
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      return resp.json();
    }
 
    // First call
    let data = await callAnthropic(body);
 
    // Web search responses stop with stop_reason = 'tool_use' and need
    // the search results fed back to get a final text answer.
    // Loop up to 5 rounds to handle multiple searches.
    let rounds = 0;
    while (data.stop_reason === 'tool_use' && rounds < 5) {
      rounds++;
 
      const toolResults = (data.content || [])
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: b.input ? JSON.stringify(b.input) : '',
        }));
 
      if (toolResults.length === 0) break;
 
      const continuedPayload = {
        ...body,
        messages: [
          ...(body.messages || []),
          { role: 'assistant', content: data.content },
          { role: 'user', content: toolResults },
        ],
      };
 
      data = await callAnthropic(continuedPayload);
    }
 
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
 
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

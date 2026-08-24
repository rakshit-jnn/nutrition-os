// netlify/functions/claude-stream.mjs
//
// A SECOND endpoint, deliberately not a replacement for claude.js.
//
// claude.js is a Netlify Functions v1 handler: it returns a { statusCode, body }
// object, which means the whole response must exist before anything is sent. That
// is why the menu shows nothing for ~20 seconds and then everything at once — the
// wait is not Claude thinking, it is the proxy holding the answer back until the
// last token.
//
// Streaming needs Functions v2, which returns a real `Response` and can hand the
// body through as it arrives. Rather than convert claude.js and risk every other
// Claude call in the app, this ships alongside it. The client falls back to
// /api/claude automatically if this endpoint is missing, so deploying the HTML
// before this file degrades to the old speed rather than breaking.
//
// Requires a redirect in netlify.toml (see HANDOFF), same as /api/claude.

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    // `stream: true` is forced here rather than trusted from the client, so this
    // endpoint cannot be called in a way that makes it buffer.
    body: JSON.stringify({ ...body, stream: true })
  });

  // An upstream error arrives as ordinary JSON, not SSE. Passing it through as a
  // stream would leave the client parsing an error body as events and reporting
  // something unhelpful, so it is surfaced as-is with its real status.
  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
};

export const config = { path: '/api/claude-stream' };

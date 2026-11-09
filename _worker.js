// Cloudflare Pages (advanced mode) worker.
// Serves the static site and adds /api/ai, a proxy to the OpenRouter API
// so the "smart teacher" features work outside Claude.
// Required secret (Settings > Variables and Secrets): OPENROUTER_API_KEY

// Primary and fallback free models on OpenRouter
const DEFAULT_MODEL = 'openrouter/free';
const QUICK_MODEL = 'openrouter/free';

const MAX_CHARS = 60000;   // total prompt size accepted from the page
const MAX_TURNS = 24;      // longest chat accepted

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function handleAI(request, env, url) {
  const apiKey = env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY;

  if (request.method === 'GET') return json({ ok: !!apiKey });
  if (request.method !== 'POST') return json({ code: 'method_not_allowed' }, 405);
  if (!apiKey) return json({ code: 'not_configured' }, 503);

  // Only accept calls coming from this site's own pages.
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return json({ code: 'forbidden' }, 403);
    } catch {
      return json({ code: 'forbidden' }, 403);
    }
  }

  let body;
  try { body = await request.json(); } catch { return json({ code: 'bad_request' }, 400); }

  let rawMessages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(rawMessages) || !rawMessages.length || rawMessages.length > MAX_TURNS) {
    return json({ code: 'bad_request' }, 400);
  }

  let total = 0;
  for (const m of rawMessages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') || typeof m.content !== 'string') {
      return json({ code: 'bad_request' }, 400);
    }
    total += m.content.length;
  }
  if (total > MAX_CHARS) return json({ code: 'bad_request' }, 400);

  const messages = rawMessages.map(m => ({ role: m.role, content: m.content }));
  const chosenModel = body.tier === 'quick' ? QUICK_MODEL : DEFAULT_MODEL;

  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': url.origin || 'https://cloudflare-pages.dev',
        'X-Title': 'Acids Bases Smart Teacher Platform'
      },
      body: JSON.stringify({
        model: chosenModel,
        max_tokens: 1500,
        messages: messages
      })
    });
  } catch {
    return json({ code: 'upstream' }, 502);
  }

  if (r.status === 429) return json({ code: 'rate_limited' }, 429);
  if (!r.ok) return json({ code: 'upstream', status: r.status }, 502);

  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  const truncated = d.choices?.[0]?.finish_reason === 'length';

  return json({ text, truncated });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') return handleAI(request, env, url);
    return env.ASSETS.fetch(request);
  }
};

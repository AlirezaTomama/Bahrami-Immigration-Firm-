/**
 * Bahrami Immigration — AI Guide proxy (Cloudflare Worker)
 * Keeps the Anthropic API key server-side. Deploy free at workers.cloudflare.com.
 *
 * Setup (5 minutes):
 * 1. dash.cloudflare.com → Workers & Pages → Create Worker → paste this file → Deploy.
 * 2. Worker → Settings → Variables → Add secret: ANTHROPIC_API_KEY = sk-ant-...
 *    (get a key at console.anthropic.com; set a monthly spend limit there too)
 * 3. Edit ALLOWED_ORIGINS below to your real domains.
 * 4. In index.html, add ONE line before the closing </body> script or at top of the main script:
 *      window.AI_PROXY_URL='https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev';
 */

const ALLOWED_ORIGINS = [
  'https://immigration-visa.ca',
  'https://www.immigration-visa.ca',
  // 'https://YOUR-USERNAME.github.io',   // uncomment while testing on GitHub Pages
];

const MODEL = 'claude-sonnet-4-6'; // forced server-side; client cannot change it
const MAX_TOKENS = 1000;           // cost ceiling per reply

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const okOrigin = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST')   return new Response('POST only', { status: 405, headers: cors });
    if (!okOrigin)                   return new Response('Origin not allowed', { status: 403, headers: cors });

    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }

    // accept only the shape our site sends; ignore everything else the client may inject
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 4) : null;
    if (!messages) return new Response('Bad request', { status: 400, headers: cors });

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages }),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};

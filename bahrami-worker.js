/**
 * Bahrami Immigration — combined Worker
 *   POST /            -> AI Guide proxy (Anthropic key stays server-side)   [step 2]
 *   POST /lead-hook   -> Supabase webhook -> Telegram notification          [step 1.5]
 *
 * Secrets to set in Cloudflare (Worker -> Settings -> Variables, type: Secret):
 *   TG_BOT_TOKEN        Telegram bot token from @BotFather
 *   TG_CHAT_ID          chat id that receives notifications
 *   HOOK_SECRET         any long random string; must match the Supabase webhook header
 *   ANTHROPIC_API_KEY   (only needed when you enable the AI Guide — step 2)
 */

/* Supabase project URL (same as the site config) — edit this one line: */
const SUPABASE_URL = 'https://dhnsbevujqksbbrqeipm.supabase.co';

const ALLOWED_ORIGINS = [
  'https://immigration-visa.ca',
  'https://www.immigration-visa.ca',
  'https://alirezatomama.github.io',
];

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/lead-hook') return leadHook(request, env);
    if (url.pathname === '/booked') return bookedMark(request, env);
    return aiProxy(request, env);
  },
};

/* ---------------- step 1.5: Supabase -> Telegram ---------------- */
async function leadHook(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (request.headers.get('x-hook-secret') !== env.HOOK_SECRET)
    return new Response('forbidden', { status: 403 });

  let p;
  try { p = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  const r = p.record || {};
  const old = p.old_record || null;

  let text = null;

  if (p.type === 'INSERT' && p.table === 'leads') {
    text =
      '🟢 لید جدید — ' + (r.name || '—') +
      '\n📞 ' + (r.phone || '—') + '  ✉️ ' + (r.email || '—') +
      '\n🧭 سرویس: ' + (r.service || '—') +
      '\n🕑 بازه ترجیحی: ' + prefFa(r.time_pref) + ' (ونکوور)' +
      (r.crs ? '\n📊 CRS: ' + r.crs : '') +
      (r.top_programs ? '\n⭐ برنامه‌ها: ' + r.top_programs : '') +
      (r.goal ? '\n🎯 هدف: ' + r.goal + (r.province ? ' · استان: ' + r.province : '') : '') +
      '\n🌐 زبان کاربر: ' + (r.lang || '—') +
      '\n⏳ هنوز زمان جلسه را قطعی نکرده — اگر تا فردا booked نشد، در همان بازه تماس بگیرید.';
  }

  if (p.type === 'UPDATE' && p.table === 'leads' &&
      r.booked_at && (!old || !old.booked_at)) {
    text =
      '✅ جلسه قطعی شد — ' + (r.name || '—') +
      '\n📞 ' + (r.phone || '—') +
      '\n🧭 ' + (r.service || '—') +
      '\nجزئیات زمان در Calendly / Google Calendar است.';
  }

  if (!text) return new Response('ignored', { status: 200 });

  const tg = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text }),
  });
  return new Response(tg.ok ? 'sent' : 'telegram error', { status: tg.ok ? 200 : 502 });
}

/* ---- mark a lead as booked (called by the site after Calendly confirms) ---- */
async function bookedMark(request, env) {
  const origin = request.headers.get('Origin') || '';
  const okOrigin = ALLOWED_ORIGINS.includes(origin);
  const cors = {
    'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
  if (!okOrigin) return new Response('Origin not allowed', { status: 403, headers: cors });
  if (!env.SB_SERVICE_KEY) return new Response('not configured', { status: 503, headers: cors });

  let b;
  try { b = await request.json(); } catch { return new Response('bad json', { status: 400, headers: cors }); }
  const id = String(b.lead_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return new Response('bad id', { status: 400, headers: cors });
  const uri = (typeof b.event_uri === 'string' && b.event_uri.indexOf('https://api.calendly.com/') === 0)
    ? b.event_uri.slice(0, 200) : null;

  const r = await fetch(SUPABASE_URL + '/rest/v1/leads?id=eq.' + id, {
    method: 'PATCH',
    headers: {
      'apikey': env.SB_SERVICE_KEY,
      'Authorization': 'Bearer ' + env.SB_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ booked_at: new Date().toISOString(), booked_event: uri }),
  });
  return new Response(r.ok ? 'ok' : 'db error', { status: r.ok ? 200 : 502, headers: cors });
}

function prefFa(v) {
  return v === 'morning' ? 'صبح' : v === 'afternoon' ? 'بعدازظهر' : v === 'evening' ? 'عصر' : '—';
}

/* ---------------- step 2: AI Guide proxy (unchanged behaviour) ---------------- */
async function aiProxy(request, env) {
  const origin = request.headers.get('Origin') || '';
  const okOrigin = ALLOWED_ORIGINS.includes(origin);
  const cors = {
    'Access-Control-Allow-Origin': okOrigin ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
  if (!okOrigin) return new Response('Origin not allowed', { status: 403, headers: cors });
  if (!env.ANTHROPIC_API_KEY) return new Response('AI not configured yet', { status: 503, headers: cors });

  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 4) : null;
  if (!messages) return new Response('Bad request', { status: 400, headers: cors });

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: messages }),
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

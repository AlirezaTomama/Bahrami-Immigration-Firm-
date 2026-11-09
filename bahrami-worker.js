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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/lead-hook') return leadHook(request, env);
    if (url.pathname === '/booked') return bookedMark(request, env);
    if (url.pathname === '/tg-update') return tgUpdate(request, env);
    if (url.pathname === '/sweep') return sweepHTTP(request, env);
    return aiProxy(request, env, ctx);
  },
  /* Cron trigger (set the schedule in Cloudflare → Settings → Trigger Events) */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(followupSweep(env));
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
      (r.chat_summary ? '\n💬 از چت AI پرسیده: ' + r.chat_summary : '') +
      (r.crs ? '\n📊 از ارزیابی — CRS: ' + r.crs : '') +
      (r.top_programs ? '\n⭐ از ارزیابی — برنامه‌های برتر: ' + r.top_programs : '') +
      (r.goal ? '\n🎯 هدف: ' + r.goal + (r.province ? ' · استان: ' + r.province : '') : '') +
      '\n🌐 زبان کاربر: ' + (r.lang || '—') +
      '\n⏳ هنوز زمان جلسه را قطعی نکرده — اگر تا فردا booked نشد، در همان بازه تماس بگیرید.';
  }

  if (p.type === 'UPDATE' && p.table === 'leads' &&
      r.booked_at && (!old || !old.booked_at)) {
    return bookedCaseFlow(r, env);
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

/* ================= case pipeline (P0) =================
   Stage machine: the machine executes, a human approves.
   Stages advance ONLY via the Telegram inline button. */
const STAGES = [
  ['consult_booked', 'جلسه رزرو شد'],
  ['consulted', 'مشاوره انجام شد'],
  ['retainer_sent', 'قرارداد ارسال شد'],
  ['retainer_signed', 'قرارداد امضا شد'],
  ['intake_docs', 'اینتیک و جمع‌آوری مدارک'],
  ['docs_complete', 'مدارک کامل شد'],
  ['forms_prep', 'آماده‌سازی فرم‌ها'],
  ['rcic_review', 'بازبینی RCIC'],
  ['ready_to_submit', 'آماده سابمیت'],
  ['submitted', 'سابمیت شد'],
  ['post_submit', 'پیگیری پس از سابمیت'],
  ['closed', 'بسته شد'],
];
function stageFa(s) {
  const f = STAGES.find(x => x[0] === s);
  return f ? f[1] : s;
}
function nextStage(s) {
  const i = STAGES.findIndex(x => x[0] === s);
  return (i >= 0 && i < STAGES.length - 1) ? STAGES[i + 1][0] : null;
}
function caseKeyboard(caseId, stage) {
  const next = nextStage(stage);
  const rows = [];
  if (next) rows.push([{ text: '✅ تایید مرحله بعد: ' + stageFa(next), callback_data: 'cs|' + caseId + '|adv' }]);
  rows.push([{ text: '📋 وضعیت پرونده', callback_data: 'cs|' + caseId + '|st' }]);
  return { inline_keyboard: rows };
}
function sb(env, path, opts) {
  opts = opts || {};
  const headers = Object.assign({
    'apikey': env.SB_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SB_SERVICE_KEY,
    'Content-Type': 'application/json',
  }, opts.headers || {});
  return fetch(SUPABASE_URL + '/rest/v1/' + path, { method: opts.method || 'GET', headers: headers, body: opts.body });
}
function tgApi(env, method, payload) {
  return fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/* booked → open (or reuse) the case, notify with approval buttons */
async function bookedCaseFlow(r, env) {
  let caseId = null, stage = 'consult_booked';
  if (env.SB_SERVICE_KEY && r.id) {
    try {
      const ins = await sb(env, 'cases?on_conflict=lead_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ lead_id: r.id, name: r.name || null, service: r.service || null }),
      });
      let row = null;
      if (ins.ok) { const arr = await ins.json().catch(() => []); row = arr && arr[0]; }
      if (!row) {
        const q = await sb(env, 'cases?lead_id=eq.' + r.id + '&select=id,stage');
        const arr = await q.json().catch(() => []); row = arr && arr[0];
      }
      if (row) { caseId = row.id; stage = row.stage || stage; }
      console.log('[case] booked flow', caseId, stage);
    } catch (e) { console.log('[case] create failed:', e && e.message); }
  }
  const text =
    '✅ جلسه قطعی شد — ' + (r.name || '—') +
    '\n📞 ' + (r.phone || '—') +
    '\n🧭 ' + (r.service || '—') +
    (caseId ? '\n📂 پرونده باز شد — مرحله: ' + stageFa(stage) : '') +
    '\nجزئیات زمان در Calendly / Google Calendar است.';
  const payload = { chat_id: env.TG_CHAT_ID, text: text };
  if (caseId) payload.reply_markup = caseKeyboard(caseId, stage);
  const tg = await tgApi(env, 'sendMessage', payload);
  return new Response(tg.ok ? 'sent' : 'telegram error', { status: tg.ok ? 200 : 502 });
}

/* Telegram webhook: inline-button approvals + /cases command */
async function tgUpdate(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.HOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  let u;
  try { u = await request.json(); } catch { return new Response('ok'); }

  if (u.callback_query) {
    const cq = u.callback_query;
    const chatOk = cq.message && cq.message.chat && String(cq.message.chat.id) === String(env.TG_CHAT_ID);
    const m = /^cs\|([0-9a-f-]{36})\|(adv|st)$/i.exec(cq.data || '');
    let note = 'درخواست نامعتبر';
    if (chatOk && m && env.SB_SERVICE_KEY) {
      const q = await sb(env, 'cases?id=eq.' + m[1] + '&select=id,stage,name,service');
      const row = (await q.json().catch(() => []))[0];
      if (!row) note = 'پرونده پیدا نشد';
      else if (m[2] === 'st') note = (row.name || '—') + ' — مرحله فعلی: ' + stageFa(row.stage);
      else {
        const next = nextStage(row.stage);
        if (!next) note = 'پرونده در مرحله آخر است';
        else {
          const up = await sb(env, 'cases?id=eq.' + row.id, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=minimal' },
            body: JSON.stringify({ stage: next, updated_at: new Date().toISOString() }),
          });
          if (up.ok) {
            try {
              await sb(env, 'case_events', {
                method: 'POST',
                headers: { 'Prefer': 'return=minimal' },
                body: JSON.stringify({ case_id: row.id, from_stage: row.stage, to_stage: next, actor: 'telegram' }),
              });
            } catch (e) {}
            note = '✓ ' + (row.name || '') + ' ← ' + stageFa(next);
            try {
              await tgApi(env, 'editMessageText', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: (cq.message.text || '') + '\n🔁 ' + stageFa(next) + ' — ' + new Date().toISOString().slice(0, 10),
                reply_markup: caseKeyboard(row.id, next),
              });
            } catch (e) {}
          } else note = 'خطای دیتابیس — دوباره بزنید';
        }
      }
    }
    await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: note.slice(0, 190) });
    return new Response('ok');
  }

  if (u.message && u.message.text && u.message.chat && String(u.message.chat.id) === String(env.TG_CHAT_ID)) {
    const t = u.message.text.trim();
    if (t === '/cases' && env.SB_SERVICE_KEY) {
      const q = await sb(env, 'cases?stage=neq.closed&select=id,name,service,stage&order=updated_at.desc&limit=15');
      const rows = await q.json().catch(() => []);
      const lines = rows.length
        ? rows.map(c => '• ' + (c.name || '—') + ' · ' + (c.service || '—') + ' ← ' + stageFa(c.stage))
        : ['پرونده بازی نیست.'];
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: '📂 پرونده‌های باز:\n' + lines.join('\n') });
    }
    return new Response('ok');
  }
  return new Response('ok');
}

/* ================= P1: automated follow-up sweep =================
   Every run: find leads older than 24h with no booking and no follow-up yet,
   send ONE digest message to the office chat, then mark them so they never repeat. */
async function followupSweep(env) {
  if (!env.SB_SERVICE_KEY || !env.TG_BOT_TOKEN) return { ok: false, why: 'not configured' };
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const q = await sb(env,
    'leads?booked_at=is.null&followed_up_at=is.null&created_at=lt.' + cutoff +
    '&select=id,name,phone,email,service,time_pref&order=created_at.asc&limit=20');
  const rows = await q.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    console.log('[sweep] nothing to follow up');
    return { ok: true, count: 0 };
  }
  const lines = rows.map(r =>
    '• ' + (r.name || '—') + ' · ' + (r.phone || r.email || '—') +
    ' · ' + (r.service || '—') + ' · بازه: ' + prefFa(r.time_pref));
  const text =
    '⏰ پیگیری — ' + rows.length + ' لید بیش از ۲۴ ساعت است رزرو نکرده:\n' +
    lines.join('\n') +
    '\nدر همان بازه ترجیحی تماس بگیرید؛ بعد از رزرو، پیام «جلسه قطعی شد» خودکار می‌آید.';
  const tg = await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: text });
  if (!tg.ok) { console.log('[sweep] telegram failed'); return { ok: false, why: 'telegram' }; }
  const ids = rows.map(r => r.id).join(',');
  const up = await sb(env, 'leads?id=in.(' + ids + ')', {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ followed_up_at: new Date().toISOString() }),
  });
  console.log('[sweep] notified', rows.length, 'marked:', up.ok);
  return { ok: true, count: rows.length };
}
/* manual trigger for testing: POST /sweep with x-hook-secret */
async function sweepHTTP(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (request.headers.get('x-hook-secret') !== env.HOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const r = await followupSweep(env);
  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
}

function prefFa(v) {
  return v === 'morning' ? 'صبح' : v === 'afternoon' ? 'بعدازظهر' : v === 'evening' ? 'عصر' : '—';
}

/* ---------------- step 2: AI Guide proxy (unchanged behaviour) ---------------- */
async function aiProxy(request, env, ctx) {
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
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;
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

  /* 2.1 — anonymous chat log (fire-and-forget; never blocks the reply) */
  if (upstream.ok && meta && env.SB_SERVICE_KEY) {
    const job = (async () => {
      try {
        let answer = '';
        try {
          const j = JSON.parse(text);
          answer = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        } catch {}
        const res = await fetch(SUPABASE_URL + '/rest/v1/chat_logs', {
          method: 'POST',
          headers: {
            'apikey': env.SB_SERVICE_KEY,
            'Authorization': 'Bearer ' + env.SB_SERVICE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            question: String(meta.q || '').slice(0, 1000),
            answer: answer.slice(0, 4000),
            lang: typeof meta.lang === 'string' ? meta.lang.slice(0, 5) : null,
            lead_id: (typeof meta.lead_id === 'string' && /^[0-9a-f-]{36}$/i.test(meta.lead_id)) ? meta.lead_id : null,
          }),
        });
        console.log('[chatlog] insert status', res.status, res.ok ? 'ok' : (await res.text()).slice(0, 200));
      } catch (e) { console.log('[chatlog] failed:', e && e.message); }
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  }

  return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

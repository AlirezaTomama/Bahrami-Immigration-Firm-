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
 *   CALENDLY_TOKEN      (optional — personal access token; enables meeting-time capture + reminders)
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
    if (url.pathname === '/lead-hook') return leadHook(request, env, ctx);
    if (url.pathname === '/booked') return bookedMark(request, env);
    if (url.pathname === '/tg-update') return tgUpdate(request, env);
    if (url.pathname === '/sweep') return sweepHTTP(request, env);
    if (url.pathname === '/setup-commands') return setupCommands(request, env);
    return aiProxy(request, env, ctx);
  },
  /* Cron trigger (set the schedule in Cloudflare → Settings → Trigger Events) */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([followupSweep(env), meetingReminders(env)]));
  },
};

/* ---------------- step 1.5: Supabase -> Telegram ---------------- */
async function leadHook(request, env, ctx) {
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
    return bookedCaseFlow(r, env, ctx);
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
async function bookedCaseFlow(r, env, ctx) {
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
  const mt = await captureMeetingTime(r, env);
  const text =
    '✅ جلسه قطعی شد — ' + (r.name || '—') +
    '\n📞 ' + (r.phone || '—') +
    '\n🧭 ' + (r.service || '—') +
    (mt ? '\n🕑 زمان جلسه: ' + vanTime(mt) + ' (ونکوور)' : '') +
    (caseId ? '\n📂 پرونده باز شد — مرحله: ' + stageFa(stage) : '') +
    (mt ? '' : '\nجزئیات زمان در Calendly / Google Calendar است.');
  const payload = { chat_id: env.TG_CHAT_ID, text: text };
  if (caseId) payload.reply_markup = caseKeyboard(caseId, stage);
  const tg = await tgApi(env, 'sendMessage', payload);
  /* P2: pre-consultation brief — generated out-of-band, never blocks the webhook */
  const briefJob = sendBrief(r, env).catch(e => console.log('[brief] failed:', e && e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(briefJob);
  return new Response(tg.ok ? 'sent' : 'telegram error', { status: tg.ok ? 200 : 502 });
}

/* ============ P2: pre-consultation brief ============
   On booking: pull the lead's assessment + chat questions, have the AI write a
   ~150-word Persian brief for the consultant. If the AI is unavailable, send the
   raw data summary instead — the office always gets SOMETHING useful. */
async function sendBrief(r, env) {
  if (!env.SB_SERVICE_KEY) return;
  let a = null, chats = [];
  try {
    const qa = await sb(env, 'assessments?lead_id=eq.' + r.id + '&order=created_at.desc&limit=1');
    a = (await qa.json().catch(() => []))[0] || null;
    const qc = await sb(env, 'chat_logs?lead_id=eq.' + r.id + '&select=question&order=created_at.desc&limit=5');
    chats = (await qc.json().catch(() => [])).map(x => x.question).filter(Boolean);
  } catch (e) {}

  const lines = [];
  lines.push('نام: ' + (r.name || '—') + ' · سرویس: ' + (r.service || '—') + ' · زبان: ' + (r.lang || '—'));
  if (a) {
    lines.push('پروفایل: سن ' + (a.age_band || '—') + ' · تحصیلات ' + (a.education || '—') + ' · CLB ' + (a.clb ?? '—') +
      (a.french ? ' · فرانسه' : '') + ' · سابقه خارجی ' + (a.foreign_years ?? '—') + ' سال · کانادایی ' + (a.canadian_years ?? '—') + ' سال' +
      (a.spouse ? ' · متاهل' : '') + (a.offer && a.offer !== 'no' ? ' · جاب‌آفر: ' + a.offer + (a.offer_tier ? ' (رده ' + a.offer_tier + ')' : '') : ''));
    lines.push('CRS: ' + (a.crs ?? '—') + ' (هسته ' + (a.crs_core ?? '—') + '، انتقال‌پذیری ' + (a.crs_trans ?? '—') + ') · تمکن اعلامی: ' + (a.funds ?? '—'));
    const res = [[a.res1, a.res1_status], [a.res2, a.res2_status], [a.res3, a.res3_status]]
      .filter(x => x[0]).map(x => x[0] + (x[1] ? ' [' + x[1] + ']' : '')).join(' · ');
    if (res) lines.push('نتایج برتر ارزیابی: ' + res);
  } else {
    lines.push('ارزیابی آنلاین انجام نشده — فقط فرم رزرو' + (r.crs ? ' · CRS اعلامی: ' + r.crs : ''));
    if (r.top_programs) lines.push('برنامه‌های برتر: ' + r.top_programs);
  }
  if (r.chat_summary) lines.push('خلاصه چت: ' + r.chat_summary);
  if (chats.length) lines.push('سوالات اخیر از دستیار: ' + chats.slice(0, 3).join(' | '));
  const dataBlock = lines.join('\n');

  let briefText = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content:
          'You are preparing an internal pre-consultation brief for a licensed Canadian immigration consultant (RCIC). ' +
          'Write in PERSIAN, max 140 words, plain text (no markdown headers). Structure: one line on who the client is; ' +
          'one line on CRS standing vs recent CEC cut-offs (507–523) if CRS known; best 1–2 pathways and why; ' +
          'client\u2019s concerns from chat if any; end with ONE concrete preparation point for the consultant ' +
          '(e.g. verify NOC against the high-wage list, confirm funds, check ECA). Use ONLY the data below; ' +
          'skip anything missing; no disclaimers, no greetings.\n\nDATA:\n' + dataBlock }] }),
      });
      if (up.ok) {
        const j = await up.json().catch(() => null);
        briefText = j && (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      } else { console.log('[brief] ai status', up.status); }
    } catch (e) { console.log('[brief] ai error:', e && e.message); }
  }

  const text = briefText
    ? '📋 بریف پیش‌جلسه — ' + (r.name || '—') + '\n' + briefText
    : '📋 داده‌های پرونده — ' + (r.name || '—') + ' (بریف هوشمند در دسترس نبود)\n' + dataBlock;
  const tg = await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: text.slice(0, 4000) });
  console.log('[brief] sent:', tg.ok, briefText ? 'ai' : 'fallback');
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
    if (t === '/sweep') {
      const r = await followupSweep(env);
      const m = await meetingReminders(env);
      if (!r.count && !m.count) await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: '✅ نه لید پیگیری‌نشده تازه‌ای هست، نه جلسه‌ای در ۲ ساعت آینده.' });
      return new Response('ok');
    }
    if (t === '/pending' && env.SB_SERVICE_KEY) {
      const q = await sb(env, 'leads?booked_at=is.null&select=name,phone,email,service,time_pref,created_at&order=created_at.desc&limit=20');
      const rows = await q.json().catch(() => []);
      let text;
      if (!rows.length) text = '🎉 لید بدون رزروی نداریم.';
      else {
        const now = Date.now();
        const lines = rows.map(r => {
          const days = Math.floor((now - new Date(r.created_at).getTime()) / 86400000);
          return '• ' + (r.name || '—') + ' · ' + (r.phone || r.email || '—') + ' · ' + (r.service || '—') +
            ' · بازه: ' + prefFa(r.time_pref) + ' · ' + (days ? days + ' روز پیش' : 'امروز');
        });
        text = '📞 لیدهای بدون رزرو (' + rows.length + '):\n' + lines.join('\n');
      }
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: text });
      return new Response('ok');
    }
    if (t === '/meetings' && env.SB_SERVICE_KEY) {
      const lo = new Date(Date.now() - 3600e3).toISOString(), hi = new Date(Date.now() + 48 * 3600e3).toISOString();
      const q = await sb(env, 'leads?meeting_at=gte.' + lo + '&meeting_at=lte.' + hi + '&select=name,phone,service,meeting_at&order=meeting_at.asc&limit=15');
      const rows = await q.json().catch(() => []);
      const text = rows.length
        ? '🗓 جلسات ۴۸ ساعت آینده (' + rows.length + '):\n' + rows.map(r => '• ' + vanTime(r.meeting_at) + ' — ' + (r.name || '—') + ' · ' + (r.phone || '—') + ' · ' + (r.service || '—')).join('\n')
        : '🗓 جلسه‌ای در ۴۸ ساعت آینده ثبت نشده. (زمان جلسه فقط برای رزروهای دارای CALENDLY_TOKEN ذخیره می‌شود.)';
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: text });
      return new Response('ok');
    }
    if (t === '/cases' && env.SB_SERVICE_KEY) {
      const q = await sb(env, 'cases?stage=neq.closed&select=name,service,stage&order=updated_at.desc&limit=50');
      const rows = await q.json().catch(() => []);
      let text;
      if (!rows.length) text = 'پرونده بازی نیست.';
      else {
        const by = {};
        rows.forEach(c => { (by[c.stage] = by[c.stage] || []).push(c.name || '—'); });
        const parts = ['📂 پرونده‌های باز (' + rows.length + '):'];
        STAGES.forEach(s => { if (by[s[0]]) parts.push('▸ ' + s[1] + ' (' + by[s[0]].length + '): ' + by[s[0]].join('، ')); });
        Object.keys(by).forEach(k => { if (!STAGES.find(s => s[0] === k)) parts.push('▸ ' + k + ': ' + by[k].join('، ')); });
        text = parts.join('\n');
      }
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: text });
      return new Response('ok');
    }
    if (t === '/help' || t === '/start') {
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: HELP_TEXT });
      return new Response('ok');
    }
    if (t.startsWith('/')) {
      await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text: 'دستور ناشناخته — راهنما: /help' });
      return new Response('ok');
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
  const m = await meetingReminders(env);
  return new Response(JSON.stringify({ followups: r, reminders: m }), { headers: { 'Content-Type': 'application/json' } });
}

/* ============ P3: meeting time + reminders ============ */
function vanTime(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch (e) { return iso; }
}
/* on booking: ask the Calendly API for the event's start time and store it on the lead */
async function captureMeetingTime(r, env) {
  try {
    if (!env.CALENDLY_TOKEN || !env.SB_SERVICE_KEY || !r.booked_event) return null;
    if (r.booked_event.indexOf('https://api.calendly.com/scheduled_events/') !== 0) return null;
    if (r.meeting_at) return r.meeting_at;
    const res = await fetch(r.booked_event, { headers: { 'Authorization': 'Bearer ' + env.CALENDLY_TOKEN } });
    if (!res.ok) { console.log('[meeting] calendly api', res.status); return null; }
    const j = await res.json().catch(() => null);
    const st = j && j.resource && j.resource.start_time;
    if (!st) return null;
    await sb(env, 'leads?id=eq.' + r.id, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ meeting_at: st }) });
    console.log('[meeting] stored', st);
    return st;
  } catch (e) { console.log('[meeting] err', e && e.message); return null; }
}
/* hourly: remind the office ~2h before each stored meeting, once */
async function meetingReminders(env) {
  if (!env.SB_SERVICE_KEY || !env.TG_BOT_TOKEN) return { ok: false, count: 0 };
  const lo = new Date(Date.now() - 10 * 60e3).toISOString();
  const hi = new Date(Date.now() + 2 * 3600e3 + 5 * 60e3).toISOString();
  const q = await sb(env, 'leads?meeting_at=gte.' + lo + '&meeting_at=lte.' + hi + '&meeting_reminded_at=is.null&select=id,name,phone,service,meeting_at&order=meeting_at.asc&limit=10');
  const rows = await q.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return { ok: true, count: 0 };
  for (const r of rows) {
    await tgApi(env, 'sendMessage', { chat_id: env.TG_CHAT_ID, text:
      '🔔 یادآوری جلسه — ' + (r.name || '—') +
      '\n🕑 ' + vanTime(r.meeting_at) + ' (ونکوور)' +
      '\n📞 ' + (r.phone || '—') + ' · ' + (r.service || '—') });
  }
  const ids = rows.map(r => r.id).join(',');
  await sb(env, 'leads?id=in.(' + ids + ')', { method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ meeting_reminded_at: new Date().toISOString() }) });
  console.log('[remind]', rows.length);
  return { ok: true, count: rows.length };
}

const HELP_TEXT =
  '📖 راهنمای بات دفتر\n' +
  '\n' +
  'دستورها:\n' +
  '/cases — پرونده‌های باز، به تفکیک مرحله\n' +
  '/pending — همه لیدهای بدون رزرو، با قدمت هر کدام\n' +
  '/meetings — جلسات ۴۸ ساعت آینده\n' +
  '/sweep — چک فوری: فقط تازه‌رسیده‌ها به آستانه ۲۴ ساعت (هر کدام یک بار اعلام می‌شود)\n' +
  '/help — همین راهنما\n' +
  '\n' +
  '🔘 مدیریت پرونده: زیر پیام «جلسه قطعی شد» هر موکل، دکمه دارد —\n' +
  '«✅ تایید مرحله بعد» پرونده را یک مرحله جلو می‌برد (۱۲ مرحله تا بسته شدن)\n' +
  '«📋 وضعیت پرونده» مرحله فعلی را نشان می‌دهد\n' +
  '\n' +
  '🤖 خودکارها (بدون دستور):\n' +
  '🟢 لید جدید — لحظه ثبت فرم\n' +
  '✅ جلسه قطعی شد + باز شدن پرونده — لحظه رزرو تقویم\n' +
  '⏰ پیگیری — هر ساعت چک می‌شود؛ لید ۲۴ساعت+ بدون رزرو فقط یک بار اعلام می‌شود\n' +
  '🔔 یادآوری جلسه — حدود ۲ ساعت قبل از هر جلسه (در صورت فعال بودن CALENDLY_TOKEN)';

/* one-time: register the bot command menu (the list Telegram shows when you type /) */
async function setupCommands(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (request.headers.get('x-hook-secret') !== env.HOOK_SECRET)
    return new Response('forbidden', { status: 403 });
  const r = await tgApi(env, 'setMyCommands', { commands: [
    { command: 'cases', description: 'پرونده‌های باز به تفکیک مرحله' },
    { command: 'pending', description: 'همه لیدهای بدون رزرو' },
    { command: 'meetings', description: 'جلسات ۴۸ ساعت آینده' },
    { command: 'sweep', description: 'چک پیگیری (تازه‌های ۲۴ساعت+)' },
    { command: 'help', description: 'راهنمای بات' },
  ]});
  return new Response(r.ok ? 'commands set' : 'telegram error', { status: r.ok ? 200 : 502 });
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

// netlify/functions/lib/claude-common.mjs   (v4.9)
//
// EVERYTHING the two Claude endpoints do lives here: /api/claude (buffered) and
// /api/claude-stream (streamed) are now two-line files that call forward(). They
// used to duplicate this logic, and a cap that exists in only one of two endpoints
// is a cap with a documented way around it (the client falls back from one to the
// other). Keeping one implementation means they cannot drift apart again.
//
// This file is in lib/ deliberately: Netlify turns top-level files in the functions
// directory into endpoints, and a subdirectory is left alone.
//
// ENVIRONMENT (Netlify -> Site configuration -> Environment variables)
//   ANTHROPIC_API_KEY    required
//   DAILY_CALL_CAP       calls per household per day. Default 25. Anything below 1,
//                        or not a number, is ignored and the default is used. DELETE
//                        it rather than leaving a test value in place: a leftover "2"
//                        is exactly what locked the app on its first open in weeks.
//   GLOBAL_DAILY_CAP     calls across ALL households per day. Default 400. This is the
//                        wallet guard: the proxy cannot verify a household ID (that
//                        lives in the Sheet), so without a global ceiling anyone
//                        inventing IDs would get a fresh quota each time.
//   MODEL_SMART / MODEL_FAST   override the model names with no redeploy of code.
//   CAP_TZ_OFFSET_MIN    minutes ahead of UTC for the daily reset. Default 330 (IST).

import { getStore } from '@netlify/blobs';

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d;
};

export const DAILY_CAP  = posInt(process.env.DAILY_CALL_CAP, 25);
export const GLOBAL_CAP = posInt(process.env.GLOBAL_DAILY_CAP, 400);
const TZ_MIN = (() => {
  const n = Number(process.env.CAP_TZ_OFFSET_MIN);
  return process.env.CAP_TZ_OFFSET_MIN && Number.isFinite(n) ? n : 330;
})();

// The client sends a difficulty, not a model name. Roughly two thirds of calls are
// mechanical (phrasing a cook order, estimating macros, parsing a gym log) and run
// cheaper and faster on `fast`. Menu choice, planning and teaching stay on `smart`.
//
// v4.9. smart moved claude-sonnet-4-5 -> claude-sonnet-4-6: same list price, and
// the replacement Anthropic names for the 4.5 line, which carries a "not sooner than
// Sept 29 2026" retirement floor. fast stays on Haiku 4.5 (its floor is Oct 15 2026,
// with 60 days' notice before any retirement). Newer models can be switched on from
// Netlify with MODEL_SMART / MODEL_FAST, but prices were not verified, so that is a
// deliberate decision, not a default.
export const MODELS = {
  fast:  process.env.MODEL_FAST  || 'claude-haiku-4-5-20251001',
  smart: process.env.MODEL_SMART || 'claude-sonnet-4-6'
};

const API = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS_CEILING = 8000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── storage ────────────────────────────────────────────────────────────────
let storeFactory = () => getStore('claude-usage');
// Test seam only. Production never calls this.
export function _useStore(factory) { storeFactory = factory; }

// The day rolls over at local midnight, not UTC midnight (which is 5:30 AM in
// India, and made "resets at midnight" untrue).
export function today() {
  return new Date(Date.now() + TZ_MIN * 60000).toISOString().slice(0, 10);
}

// A household ID is used inside a storage key, so anything unexpected is folded
// into one shared bucket instead of minting a new quota.
const SAFE_ID = /^[A-Za-z0-9_.-]{1,40}$/;
export function householdKey(hh) {
  const s = String(hh == null ? '' : hh);
  return SAFE_ID.test(s) ? s : '_anon';
}

// ── metering ───────────────────────────────────────────────────────────────
// Returns an OBSERVABLE result. The previous version swallowed every failure and
// reported success, so a broken cap and a working cap looked identical from outside.
//   { ok:false, reason, count, cap }                       -> refuse (429)
//   { ok:true,  counted:true,  count, cap, hKey, gKey }    -> proceed, one call spent
//   { ok:true,  counted:false, error }                     -> proceed UNMETERED, and say so
// Failing open is deliberate: an unmetered call is a smaller problem than a
// household that cannot get dinner. The error travels in a response header.
//
// Not atomic: two simultaneous calls can read the same count and both write count+1.
// For a household-sized cap that undercounts by at most a call or two.
export async function meter(hh) {
  const who = householdKey(hh);
  const day = today();
  const hKey = `${who}:${day}`;
  const gKey = `__all:${day}`;
  try {
    const store = storeFactory();
    const h = Number((await store.get(hKey)) || 0);
    const g = Number((await store.get(gKey)) || 0);
    if (h >= DAILY_CAP)  return { ok: false, reason: 'household', count: h, cap: DAILY_CAP };
    if (g >= GLOBAL_CAP) return { ok: false, reason: 'global',    count: g, cap: GLOBAL_CAP };
    await store.set(hKey, String(h + 1));
    await store.set(gKey, String(g + 1));
    return { ok: true, counted: true, count: h + 1, cap: DAILY_CAP, hKey, gKey };
  } catch (e) {
    return { ok: true, counted: false, count: 0, cap: DAILY_CAP,
             error: String((e && e.message) || e) };
  }
}

// A call Anthropic rejected (bad key, bad model, outage, rate limit) did not give
// the household a menu, so it must not cost them one. Counting happens BEFORE the
// call because it has to be able to refuse; this is the other half.
export async function refund(gate) {
  if (!gate || !gate.counted) return;
  try {
    const store = storeFactory();
    for (const k of [gate.hKey, gate.gKey]) {
      const cur = Number((await store.get(k)) || 0);
      await store.set(k, String(Math.max(0, cur - 1)));
    }
  } catch { /* a failed refund costs one call; never worth failing the request */ }
}

export function meterHeaders(gate) {
  const h = {
    'x-nos-count': String(gate.count == null ? 0 : gate.count),
    'x-nos-cap': String(gate.cap == null ? DAILY_CAP : gate.cap),
    'Access-Control-Expose-Headers': 'x-nos-count, x-nos-cap, x-nos-meter-error'
  };
  if (gate.error) h['x-nos-meter-error'] = gate.error.slice(0, 200).replace(/[^\x20-\x7e]/g, ' ');
  return h;
}

function json(status, obj, gate) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(gate ? meterHeaders(gate) : {}) }
  });
}

// A friendly, parseable refusal. To the person this is a limit, not a crash.
function cappedResponse(gate) {
  const message = gate.reason === 'global'
    ? 'The service has reached its limit for today. Try again tomorrow.'
    : "That's today's limit for this household. It resets at midnight.";
  return json(429, { error: { message }, capped: true }, gate);
}

// ── the one implementation both endpoints call ─────────────────────────────
export async function forward(req, { stream }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return json(400, { error: 'Invalid JSON' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'API key not configured' });

  const { hh, tier, ...payload } = body;

  const gate = await meter(hh);
  if (!gate.ok) return cappedResponse(gate);

  // A tier wins; a raw model name from an old client is honoured; failing both, smart.
  payload.model = MODELS[tier] || payload.model || MODELS.smart;
  const mt = Number(payload.max_tokens);
  payload.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.min(Math.floor(mt), MAX_TOKENS_CEILING) : 1024;

  let upstream;
  try {
    upstream = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // Forced here, not trusted from the client: the streaming endpoint must stream
      // and the buffered one must not.
      body: JSON.stringify({ ...payload, stream: !!stream })
    });
  } catch (e) {
    await refund(gate);
    return json(502, { error: { message: 'Could not reach Anthropic: ' + ((e && e.message) || e) } }, gate);
  }

  // An upstream error is ordinary JSON, never SSE, and carries its real status so the
  // client can tell a bad key (401) from an overload (529) from a bad model (404).
  if (!upstream.ok) {
    const text = await upstream.text();
    await refund(gate);
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...CORS, ...meterHeaders(gate) }
    });
  }

  if (stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                 'Connection': 'keep-alive', ...CORS, ...meterHeaders(gate) }
    });
  }
  const text = await upstream.text();
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...meterHeaders(gate) }
  });
}

// ── /api/usage ─────────────────────────────────────────────────────────────
// Writes a value and reads it BACK. A bare get() against a never-provisioned store
// returns null, which reads identically to "zero calls today" and would hide exactly
// the failure this probe exists to find. Never returns the API key, only whether one
// is configured.
export async function usageReport(hh) {
  const day = today();
  const out = {
    day, tz_offset_min: TZ_MIN,
    cap: DAILY_CAP, global_cap: GLOBAL_CAP,
    cap_env_raw: process.env.DAILY_CALL_CAP == null ? null : process.env.DAILY_CALL_CAP,
    api_key_configured: !!process.env.ANTHROPIC_API_KEY,
    models: MODELS
  };
  try {
    const store = storeFactory();
    const probe = String(Date.now());
    await store.set('__probe', probe);
    const back = await store.get('__probe');
    out.blobs = back === probe ? 'working' : `FAILED: wrote ${probe}, read ${back}`;
    if (hh) {
      const who = householdKey(hh);
      out.household = who;
      out.count_today = Number((await store.get(`${who}:${day}`)) || 0);
    }
    out.global_today = Number((await store.get(`__all:${day}`)) || 0);
  } catch (e) {
    out.blobs = 'FAILED';
    out.blobs_error = String((e && e.message) || e);
  }
  return out;
}

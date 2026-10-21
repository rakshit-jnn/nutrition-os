// netlify/functions/lib/claude-common.mjs   (v4.25)
//
// v4.25 (Phase 1, "lock the doors"). Nothing reaches Anthropic unless the caller proves it
// belongs to a real kitchen, and then only in the shapes the app itself uses:
//   1. Same-site only: a request from another website's page (Origin header) is refused.
//   2. The kitchen is checked with Apps Script (house name + PIN, or a Google sign-in) and the
//      answer is remembered for 10 minutes, so most calls add no delay. A wrong answer is
//      remembered for 1 minute. If Apps Script can't be reached the call is refused (503):
//      the app is unusable without the Sheet anyway, and "fail open" is how wallets get drained.
//   3. The caller picks a tier (fast | smart), never a model. Only whitelisted fields are
//      forwarded (model, max_tokens, messages, system): no tools, no thinking, no other options.
//   4. Size limits: <= 4 messages, <= 40,000 characters, max_tokens <= 4,000.
//   5. The same daily cap (per kitchen and global) counts every call, including photo scans.
//   6. Owner door for tests: header x-nos-owner-key equal to env NOS_OWNER_KEY skips the kitchen
//      check and may name a model (tools/model-check.js uses it). No env value = no owner door.
//
// v4.25: every successful call is logged (tokens, model, purpose, estimated cost) into a
// per-day, per-household total, shown by /api/usage. A streamed answer that dies before
// it finishes gives the household its call back (it already did for calls that never start).
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
//   USD_INR              rupees per dollar for the cost estimate in /api/usage. Default 88.
//   MODEL_VISION         model for photo scans. Default: the same as MODEL_SMART.
//   APPS_SCRIPT_URL      the Apps Script web-app address used to check kitchens. Default: the
//                        one in index.html (it is public in the page, so not a secret).
//   NOS_OWNER_KEY        optional. Lets YOU run tools/model-check.js after the lock. Pick a long
//                        random string; leave unset to have no such door at all.

import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

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
// Photo scans. They ran on claude-sonnet-4-5 (retiring about 30 Nov 2026), unmetered. Now the
// same model as `smart` unless MODEL_VISION says otherwise.
MODELS.vision = process.env.MODEL_VISION || MODELS.smart;

// List prices in USD per million tokens, checked 2026-10-21 on
// https://platform.claude.com/docs/en/about-claude/pricing . Matched by model-name prefix.
// cacheRead is the multiplier on the input price for cache hits; cache writes are 1.25x.
// The cost shown is an ESTIMATE from these numbers; the Anthropic console bill is the truth.
export const PRICES = {
  'claude-sonnet-5-5': { in: 2,   out: 10,  cacheRead: 0.05 },
  'claude-sonnet-4-6': { in: 3,   out: 15,  cacheRead: 0.1 },
  'claude-sonnet-4-5': { in: 3,   out: 15,  cacheRead: 0.1 },
  'claude-haiku-5-5':  { in: 0.1, out: 0.5, cacheRead: 0.1 },
  'claude-haiku-4-5':  { in: 1,   out: 5,   cacheRead: 0.1 },
  'claude-opus-5-5':   { in: 4,   out: 20,  cacheRead: 0.05 }
};
const USD_INR = (() => { const n = Number(process.env.USD_INR); return Number.isFinite(n) && n > 0 ? n : 88; })();

export function priceFor(model) {
  const m = String(model || '');
  let best = null, len = 0;
  Object.keys(PRICES).forEach(k => { if (m.startsWith(k) && k.length > len) { best = PRICES[k]; len = k.length; } });
  return best;
}
export function costUSD(model, u) {
  const p = priceFor(model);
  if (!p || !u) return null;
  const inp = (u.in || 0) * p.in + (u.cacheWrite || 0) * p.in * 1.25 + (u.cacheRead || 0) * p.in * p.cacheRead;
  return (inp + (u.out || 0) * p.out) / 1e6;
}

const API = 'https://api.anthropic.com/v1/messages';
// What the app really sends is at most ~1,600 output tokens and ~4 KB of prompt; these limits leave
// 2-3x headroom for the app growing, and cap what a stolen PIN could spend per call.
export const LIMITS = { maxTokens: 4000, messages: 4, chars: 40000, system: 8000,
                        bodyBytes: 120000, imageChars: 3500000, imageBodyBytes: 4000000 };

// No Access-Control-Allow-Origin on purpose. The page and the functions share one address, so the
// browser needs no CORS permission; leaving it out means other websites' pages cannot read our
// answers or send us preflighted calls.
const CORS = {};

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

// ── usage log (v4.25) ───────────────────────────────────────────────────────
// One JSON total per day per household: calls, tokens, estimated USD, and the same split
// by purpose ("menu", "dish-learn", "cook-order"…) and by model. Read-modify-write, so two
// calls finishing in the same instant can lose one increment; fine for an estimate, and
// it never blocks or fails the call itself.
const PURPOSE_RE = /^[a-z][a-z0-9-]{0,23}$/;
export function purposeOf(req) {
  const p = String((req.headers && req.headers.get && req.headers.get('x-nos-purpose')) || '').toLowerCase();
  return PURPOSE_RE.test(p) ? p : 'unlabelled';
}
function addInto(t, u, usd) {
  t.calls = (t.calls || 0) + 1;
  t.in = (t.in || 0) + (u.in || 0); t.out = (t.out || 0) + (u.out || 0);
  t.cacheRead = (t.cacheRead || 0) + (u.cacheRead || 0); t.cacheWrite = (t.cacheWrite || 0) + (u.cacheWrite || 0);
  t.usd = Math.round(((t.usd || 0) + (usd || 0)) * 1e6) / 1e6;
  if (u.failed) t.failed = (t.failed || 0) + 1;
  return t;
}
export async function recordUsage(hh, entry) {
  try {
    const store = storeFactory();
    const key = `agg/${today()}/${householdKey(hh)}`;
    let t = {};
    try { t = JSON.parse((await store.get(key)) || '{}') || {}; } catch { t = {}; }
    const usd = costUSD(entry.model, entry);
    addInto(t, entry, usd);
    t.byPurpose = t.byPurpose || {}; t.byPurpose[entry.purpose] = addInto(t.byPurpose[entry.purpose] || {}, entry, usd);
    t.byModel = t.byModel || {};     t.byModel[entry.model] = addInto(t.byModel[entry.model] || {}, entry, usd);
    await store.set(key, JSON.stringify(t));
  } catch { /* logging must never cost anyone their menu */ }
}
function usageFrom(u) {
  return { in: Number(u && u.input_tokens) || 0, out: Number(u && u.output_tokens) || 0,
           cacheRead: Number(u && u.cache_read_input_tokens) || 0,
           cacheWrite: Number(u && u.cache_creation_input_tokens) || 0 };
}

// Passes the SSE stream through untouched while reading the usage numbers out of it.
// When it ends: log the usage; if Anthropic never sent message_stop (the answer was cut
// off), give the household its call back, because the client will retry.
export function meteredStream(body, onDone) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const u = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, stopped: false };
  let buf = '', finished = false;
  const finish = async (err) => { if (finished) return; finished = true; try { await onDone(u, err); } catch {} };
  const scan = () => {
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(u, usageFrom(ev.message.usage));
      else if (ev.type === 'message_delta' && ev.usage) {
        if (ev.usage.output_tokens != null) u.out = Number(ev.usage.output_tokens) || u.out;
        if (ev.usage.input_tokens) u.in = Number(ev.usage.input_tokens);
      } else if (ev.type === 'message_stop') u.stopped = true;
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        // Log (and refund) BEFORE closing: once the stream closes the platform may stop the function.
        if (done) { await finish(null); controller.close(); return; }
        controller.enqueue(value);
        buf += dec.decode(value, { stream: true });
        scan();
      } catch (e) { await finish(e); controller.error(e); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } catch {} await finish(new Error('cancelled')); }
  });
}

// ── the gate (v4.25, Phase 1) ──────────────────────────────────────────────
// The address of the Apps Script web app, from index.html. Public by design (every phone has it).
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxXDdY5y_QUVIML1Zb4nwTnuryI_Uqhe-EGwc_iDT_s5OZ9wJNcfWvILo4rCC5bN6XT/exec';
const AUTH_OK_MS = 10 * 60 * 1000;     // a kitchen that checked out is trusted for 10 minutes
const AUTH_BAD_MS = 60 * 1000;         // a refusal is remembered for 1 minute (stops hammering Apps Script)
const AUTH_TIMEOUT_MS = 9000;
const authMemo = new Map();            // per warm function instance; nothing secret is kept (only hashes)
let verifier = null;
// Test seam only. Production never calls these.
export function _useVerifier(fn) { verifier = fn; authMemo.clear(); }
export function _clearAuthMemo() { authMemo.clear(); }

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

// Asks Apps Script "is this house name + PIN (or sign-in) real?" using its own whoami action,
// which runs the very same check as every Sheet call, including the 5-wrong-PINs lockout.
async function askBackend(hh, pin, sess) {
  if (verifier) return verifier(hh, pin, sess);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AUTH_TIMEOUT_MS);
  try {
    const r = await fetch(process.env.APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL,
      { method: 'POST', body: JSON.stringify({ action: 'whoami', hh, pin, sess }), signal: ctl.signal });
    const d = await r.json();
    if (d && d.error) return { ok: false, status: 401, message: String(d.error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 120) };
    if (d && String(d.household || '').toLowerCase() === hh) return { ok: true };
    return { ok: false, status: 503, transient: true, message: 'Could not check your kitchen right now. Try again in a minute.' };
  } catch {
    return { ok: false, status: 503, transient: true, message: 'Could not check your kitchen right now. Try again in a minute.' };
  } finally { clearTimeout(timer); }
}

export async function verifyKitchen(hh, pin, sess) {
  const key = hh + '|' + sha(pin || '') + '|' + sha(sess || '');
  const hit = authMemo.get(key);
  if (hit && hit.until > Date.now()) return hit.res;
  const res = await askBackend(hh, pin, sess);
  if (!res.transient) authMemo.set(key, { res, until: Date.now() + (res.ok ? AUTH_OK_MS : AUTH_BAD_MS) });
  if (authMemo.size > 500) authMemo.clear();
  return res;
}

// A request from another website's page carries that site's Origin. The app and these functions
// share one address, so the Origin's host must be this request's own host. No Origin header
// (curl, a script) passes this test and meets the PIN check instead: this is hygiene, not the lock.
function originRefused(req) {
  const o = req.headers.get('origin');
  if (!o) return false;
  let oh;
  try { oh = new URL(o).host.toLowerCase(); } catch { return true; }
  const ok = new Set();
  const add = (h) => { if (h) ok.add(String(h).toLowerCase()); };
  try { add(new URL(req.url).host); } catch { /* ignore */ }
  add(req.headers.get('host')); add(req.headers.get('x-forwarded-host'));
  (process.env.ALLOWED_ORIGINS || '').split(',').forEach((x) => { try { add(new URL(x.trim()).host); } catch { /* ignore */ } });
  return !ok.has(oh);
}

// The owner door (see the header). Constant-time compare; closed when NOS_OWNER_KEY is not set.
export function ownerKeyOk(given) {
  const k = process.env.NOS_OWNER_KEY || '';
  if (!k) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(k);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function ownerOk(req) { return ownerKeyOk(req.headers.get('x-nos-owner-key')); }

// shape 'chat' → {error:{message}}, shape 'vision' → {error:"message"} (what each client reads)
function deny(status, message, shape, gate) {
  return json(status, { error: shape === 'vision' ? message : { message }, denied: true }, gate);
}

// Everything that must be true BEFORE a call is counted or sent: same site, small body, valid
// JSON, and (unless the owner door is used) a kitchen that Apps Script recognises.
async function guard(req, shape) {
  if (originRefused(req)) return { res: deny(403, 'This request did not come from the app.', shape) };
  const limit = shape === 'vision' ? LIMITS.imageBodyBytes : LIMITS.bodyBytes;
  const len = Number(req.headers.get('content-length') || 0);
  if (len > limit) return { res: deny(413, 'That request is too large.', shape) };
  let text;
  try { text = await req.text(); } catch { return { res: deny(400, 'Invalid request', shape) }; }
  if (text.length > limit) return { res: deny(413, 'That request is too large.', shape) };
  let body;
  try { body = JSON.parse(text); } catch { return { res: deny(400, 'Invalid JSON', shape) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { res: deny(400, 'Invalid JSON', shape) };

  const owner = ownerOk(req);
  // typeof check: String(['home']) would be 'home', and a made-up value must never pass as a name.
  let hh = typeof body.hh === 'string' ? body.hh.trim().toLowerCase() : '';
  if (owner) {
    if (!SAFE_ID.test(hh)) hh = '_owner';
  } else {
    if (!SAFE_ID.test(hh)) return { res: deny(401, 'Open the app and choose your kitchen first.', shape) };
    const v = await verifyKitchen(hh, String(body.pin == null ? '' : body.pin).slice(0, 40), String(body.sess || '').slice(0, 2000));
    if (!v.ok) return { res: deny(v.status || 401, v.message || 'Not allowed', shape) };
  }
  return { body, hh, owner };
}

// Chat requests: a tier (never a model), whitelisted fields, hard size limits.
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{2,60}$/;
export function cleanChat(b, owner) {
  if (!b || typeof b !== 'object') return { error: 'Invalid request' };
  let model = b.tier === 'fast' ? MODELS.fast : b.tier === 'smart' ? MODELS.smart : null;
  if (owner && typeof b.model === 'string' && MODEL_RE.test(b.model)) model = b.model;
  if (!model) return { error: 'tier must be "fast" or "smart"' };
  const msgs = b.messages;
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > LIMITS.messages) return { error: 'messages: 1 to ' + LIMITS.messages + ' required' };
  let chars = 0;
  const messages = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return { error: 'each message needs a role and text content' };
    chars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  const payload = { model, messages };
  if (b.system != null) {
    if (typeof b.system !== 'string' || b.system.length > LIMITS.system) return { error: 'system must be text under ' + LIMITS.system + ' characters' };
    chars += b.system.length; payload.system = b.system;
  }
  if (chars > LIMITS.chars) return { error: 'prompt too long (' + chars + ' characters; limit ' + LIMITS.chars + ')' };
  const mt = Number(b.max_tokens);
  payload.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.min(Math.floor(mt), LIMITS.maxTokens) : 1024;
  return { payload };
}

// ── the one implementation both chat endpoints call ─────────────────────────
export async function forward(req, { stream }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const g = await guard(req, 'chat');
  if (g.res) return g.res;
  const { hh, owner } = g;
  const c = cleanChat(g.body, owner);
  if (c.error) return deny(400, c.error, 'chat');
  const payload = c.payload;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'API key not configured' });
  const purpose = purposeOf(req);

  const gate = await meter(hh);
  if (!gate.ok) return cappedResponse(gate);

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
    const model = payload.model;
    const body2 = meteredStream(upstream.body, async (u, err) => {
      const complete = u.stopped && !err;
      if (!complete) await refund(gate);
      await recordUsage(hh, { model, purpose, in: u.in, out: u.out, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, failed: !complete });
    });
    return new Response(body2, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                 'Connection': 'keep-alive', ...CORS, ...meterHeaders(gate) }
    });
  }
  const text = await upstream.text();
  let usage = null;
  try { usage = usageFrom(JSON.parse(text).usage); } catch { usage = null; }
  if (usage) await recordUsage(hh, Object.assign({ model: payload.model, purpose }, usage));
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...meterHeaders(gate) }
  });
}

// ── photo scan (v4.25) ──────────────────────────────────────────────────────
// Was its own unmetered function on a retiring model; now the same gate, the same daily cap and
// the same usage log as every other call. The answer keeps its old shape: {success, data}.
const VISION_PROMPTS = {
  'nutrition-label': 'Extract nutrition info from this label. Return JSON only: {"protein":0,"calories":0,"carbs":0,"fat":0,"fiber":0,"serving_size":""}. Numbers only, null if missing.',
  'inventory-photo': 'This image is EITHER a photo of food/groceries (a shelf, fridge, counter or bag) OR a screenshot of a grocery order or receipt (Blinkit, Zepto, Instamart, BigBasket, DMart, Swiggy). Work out which, then list every food item with its quantity. For a screenshot, read the quantity from the listing (e.g. "500 g", "1 L", "6 pieces") and ignore prices, delivery fees, offers and totals. For a photo, estimate the quantity from what is visible. Indian grocery names. Return JSON only: {"items":[{"name":"","quantity":""}]}',
  'order-screenshot': 'Extract all ordered items. Return JSON only: {"items":[{"name":"","quantity":"","price":0}]}',
  'dish-recognition': 'Identify this dish and estimate macros for the full portion. Return JSON only: {"dish_name":"","components":[],"protein":0,"calories":0,"carbs":0,"fat":0,"fiber":0}'
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export async function forwardVision(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const g = await guard(req, 'vision');
  if (g.res) return g.res;
  const { body, hh } = g;
  const { imageBase64, imageType, taskType } = body;

  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) return json(400, { error: 'Invalid image' });
  if (imageBase64.length > LIMITS.imageChars) return deny(413, 'That image is too large.', 'vision');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(imageBase64.slice(0, 2000))) return json(400, { error: 'Invalid image' });
  const prompt = Object.prototype.hasOwnProperty.call(VISION_PROMPTS, taskType) ? VISION_PROMPTS[taskType] : null;
  if (!prompt) return json(400, { error: 'Unknown task type: ' + String(taskType).slice(0, 40) });
  // Claude's vision API accepts only these four; anything else is sent as JPEG (the app re-encodes to JPEG).
  const sent = String(imageType || '').toLowerCase();
  const mediaType = IMAGE_TYPES.includes(sent) ? sent : 'image/jpeg';

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'API key not configured' });

  const gate = await meter(hh);
  if (!gate.ok) {
    const msg = gate.reason === 'global' ? 'The service has reached its limit for today. Try again tomorrow.'
                                         : "That's today's limit for this household. It resets at midnight.";
    return json(429, { error: msg, capped: true }, gate);
  }

  const model = MODELS.vision;
  let upstream;
  try {
    upstream = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt }] }] })
    });
  } catch (e) {
    await refund(gate);
    return json(502, { error: 'Could not reach Anthropic: ' + ((e && e.message) || e) }, gate);
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    await refund(gate);
    let msg = 'Claude API error ' + upstream.status;
    try { msg = JSON.parse(text).error.message || msg; } catch { /* keep the status text */ }
    return json(upstream.status === 429 || upstream.status >= 500 ? 502 : 500, { error: msg }, gate);
  }
  let data;
  try { data = JSON.parse(text); } catch { await refund(gate); return json(502, { error: 'Unreadable answer from Claude' }, gate); }
  await recordUsage(hh, Object.assign({ model, purpose: ('vision-' + taskType).slice(0, 24) }, usageFrom(data.usage)));
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = out.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  return json(200, { success: true, data: parsed || { raw: out } }, gate);
}

// ── /api/usage ─────────────────────────────────────────────────────────────
// Writes a value and reads it BACK. A bare get() against a never-provisioned store
// returns null, which reads identically to "zero calls today" and would hide exactly
// the failure this probe exists to find. Never returns the API key, only whether one
// is configured.
export async function usageReport(hh, owner) {
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
    // v4.25. Tokens and estimated cost. Per household when ?hh= is given (today and the
    // last 7 days), and for all households today.
    const inr = usd => Math.round(usd * USD_INR * 100) / 100;
    const read = async k => { try { return JSON.parse((await store.get(k)) || 'null'); } catch { return null; } };
    out.cost_note = 'Estimated from list prices x token counts; USD_INR=' + USD_INR + '. The Anthropic console bill is the truth.';
    if (hh) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() + TZ_MIN * 60000 - i * 86400000).toISOString().slice(0, 10);
        const t = await read(`agg/${d}/${householdKey(hh)}`);
        days.push({ day: d, calls: (t && t.calls) || 0, usd: (t && t.usd) || 0, inr: inr((t && t.usd) || 0) });
        if (i === 0) out.usage_today = t ? Object.assign({ inr: inr(t.usd || 0) }, t) : { calls: 0 };
      }
      out.last_7_days = days;
    }
    try {
      const { blobs } = await store.list({ prefix: `agg/${day}/` });
      let calls = 0, usd = 0; const byHousehold = {};
      for (const b of blobs || []) {
        const t = await read(b.key);
        if (!t) continue;
        calls += t.calls || 0; usd += t.usd || 0;
        byHousehold[b.key.split('/').pop()] = { calls: t.calls || 0, inr: inr(t.usd || 0) };
      }
      // Kitchen names are half of a login, so the list is shown only with ?key=<NOS_OWNER_KEY>.
      out.all_households_today = { calls, usd: Math.round(usd * 1e4) / 1e4, inr: inr(usd), households: Object.keys(byHousehold).length };
      if (owner) out.all_households_today.byHousehold = byHousehold;
    } catch (e) { out.all_households_today = { error: String((e && e.message) || e) }; }
  } catch (e) {
    out.blobs = 'FAILED';
    out.blobs_error = String((e && e.message) || e);
  }
  return out;
}

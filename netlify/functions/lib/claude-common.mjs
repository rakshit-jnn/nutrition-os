// netlify/functions/lib/claude-common.mjs
//
// Shared by BOTH Claude endpoints. There were two of them — a streaming v2
// function and a buffered v1 one — and the buffered one was the fallback the
// client reaches for whenever streaming fails. A cap that lived in only one of
// them was therefore a cap with a documented way around it.
//
// This file is in lib/ deliberately: Netlify turns top-level files in the
// functions directory into endpoints, and a subdirectory whose name doesn't
// match the file inside it is left alone.

import { getStore } from '@netlify/blobs';

// Above what a genuinely engaged household reaches, and low enough that ten of
// them is a number you can predict at the start of the month.
export const DAILY_CAP = Number(process.env.DAILY_CALL_CAP || 25);

// The client sends a difficulty, not a model name. Roughly two thirds of calls
// are mechanical — phrasing an order, estimating macros, parsing a gym log — and
// they run cheaper and faster here. One place to edit when a model is superseded.
export const MODELS = {
  fast:  'claude-haiku-4-5-20251001',
  smart: 'claude-sonnet-4-5'
};

export async function meter(hh) {
  if (!hh) return { ok: true, count: 0 };   // pre-v4.0 client: don't block it
  try {
    const store = getStore('claude-usage');
    const key = `${hh}:${new Date().toISOString().slice(0, 10)}`;
    const count = Number((await store.get(key)) || 0);
    if (count >= DAILY_CAP) return { ok: false, count };
    await store.set(key, String(count + 1));
    return { ok: true, count: count + 1 };
  } catch {
    // Blobs being down must not take dinner down with it. An unmetered call is a
    // far smaller problem than a household that can't get a menu.
    return { ok: true, count: 0 };
  }
}

export const CAPPED_BODY = JSON.stringify({
  error: { message: "That's today's limit for this household. It resets at midnight." },
  capped: true
});

// netlify/functions/usage.mjs   (v4.9)
//
// GET /api/usage?hh=home. The question "is the cap working, and what is it set to?"
// used to be unanswerable from outside: a failed cap and a working one looked the same.
// Shows the real configured cap (and the raw env value, so a leftover test value like
// DAILY_CALL_CAP=2 is visible at a glance), today's count, and whether Blobs works.
import { usageReport } from './lib/claude-common.mjs';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const hh = new URL(req.url).searchParams.get('hh') || '';
  return new Response(JSON.stringify(await usageReport(hh), null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
};

export const config = { path: '/api/usage' };

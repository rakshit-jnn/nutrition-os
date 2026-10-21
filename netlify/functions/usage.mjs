// netlify/functions/usage.mjs   (v4.9)
//
// GET /api/usage?hh=home   (add &key=<NOS_OWNER_KEY> to also list every kitchen's name). The question "is the cap working, and what is it set to?"
// used to be unanswerable from outside: a failed cap and a working one looked the same.
// Shows the real configured cap (and the raw env value, so a leftover test value like
// DAILY_CALL_CAP=2 is visible at a glance), today's count, and whether Blobs works.
import { usageReport, ownerKeyOk } from './lib/claude-common.mjs';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const q = new URL(req.url).searchParams;
  const hh = q.get('hh') || '';
  return new Response(JSON.stringify(await usageReport(hh, ownerKeyOk(q.get('key'))), null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
};

export const config = { path: '/api/usage' };

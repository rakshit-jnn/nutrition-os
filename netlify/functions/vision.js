// netlify/functions/vision.js   (v4.25)
//
// /api/vision: photo scan. All the logic (kitchen check, daily cap, model, usage log) now lives in
// lib/claude-common.mjs (forwardVision), so a photo scan is counted and limited exactly like every
// other Claude call. This file only turns Netlify's classic event into a standard Request and the
// standard Response back, so the file name and the /api/vision address stay as they were.
exports.handler = async (event) => {
  const { forwardVision } = await import('./lib/claude-common.mjs');
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || 'localhost';
  const proto = h['x-forwarded-proto'] || 'https';
  const headers = {};
  Object.keys(h).forEach((k) => { if (h[k] != null) headers[k] = String(h[k]); });
  const init = { method: event.httpMethod, headers };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD' && event.body != null)
    init.body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const res = await forwardVision(new Request(proto + '://' + host + (event.path || '/api/vision'), init));
  const out = {};
  res.headers.forEach((v, k) => { out[k] = v; });
  return { statusCode: res.status, headers: out, body: await res.text() };
};

// netlify/functions/claude-stream.mjs   (v4.9)
//
// /api/claude-stream: Functions v2, which can hand the body through as it arrives,
// so the first dish of a menu shows in a couple of seconds instead of waiting for the
// last token. Everything else (the cap, refunds, the tier-to-model mapping, error
// passthrough) is shared with /api/claude in lib/claude-common.mjs.
import { forward } from './lib/claude-common.mjs';

export default async (req) => forward(req, { stream: true });

export const config = { path: '/api/claude-stream' };

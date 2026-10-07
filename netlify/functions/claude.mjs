// netlify/functions/claude.mjs   (v4.9)
//
// /api/claude: the buffered endpoint, and the one the client falls back to whenever
// streaming fails. It was missing from the live deploy (the old claude.js was deleted
// and this replacement never shipped), so every non-menu Claude call returned 404.
//
// A Functions v2 file routes itself through `config.path`, exactly as claude-stream
// does. All behaviour lives in lib/claude-common.mjs, shared with the streaming
// endpoint, so the two can never disagree about the cap or the models.
import { forward } from './lib/claude-common.mjs';

export default async (req) => forward(req, { stream: false });

export const config = { path: '/api/claude' };

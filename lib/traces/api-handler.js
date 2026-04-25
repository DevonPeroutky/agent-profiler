// @ts-check
// Shared HTTP handler for /api/traces. Same signature works as a raw
// node:http listener and as a Connect/Vite middleware (Connect's `next`
// is optional and we don't call it).

import { getAllTraces } from './store.js';

const LIMIT = Number(process.env.AGENT_TRACE_LIMIT ?? 200);

/**
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 */
export function tracesHandler(_req, res) {
  try {
    const body = JSON.stringify({ traces: getAllTraces(LIMIT) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } catch (e) {
    console.error('[agent-profiler] /api/traces error', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: e instanceof Error ? e.message : 'internal error',
    }));
  }
}

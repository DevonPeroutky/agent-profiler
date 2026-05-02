// @ts-check
// Shared HTTP handler for /api/traces. Same signature works as a raw
// node:http listener and as a Connect/Vite middleware (Connect's `next`
// is optional and we don't call it).

import { listSessions } from './sessions.js';
import { getAllTraces } from './store.js';
import { readTranscript } from './transcripts.js';

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
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : 'internal error',
      }),
    );
  }
}

/**
 * Returns the raw JSONL bundle for a session: main transcript records plus
 * each sibling subagent transcript. Used by the Debug tab.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function transcriptHandler(req, res) {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId query param required' }));
      return;
    }
    const file = listSessions().find((f) => f.sessionId === sessionId);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown sessionId: ${sessionId}` }));
      return;
    }
    const bundle = readTranscript(file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bundle));
  } catch (e) {
    console.error('[agent-profiler] /api/transcript error', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : 'internal error',
      }),
    );
  }
}

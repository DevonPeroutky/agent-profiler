// Node-only Vite plugin. Do NOT import from ui/src/ — uses node:fs.

import type { Plugin } from 'vite';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .js module with @ts-check JSDoc types, typechecked separately
import { getAllTraces } from '../lib/traces/store.js';

const LIMIT = Number(process.env.AGENT_TRACE_LIMIT ?? 200);

export function transcriptApi(): Plugin {
  const handle: Plugin['configureServer'] = (server) => {
    server.middlewares.use('/api/traces', (_req, res) => {
      try {
        const body = JSON.stringify({ traces: getAllTraces(LIMIT) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch (e) {
        console.error('[agent-trace] /api/traces error', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: e instanceof Error ? e.message : 'internal error',
        }));
      }
    });
  };
  return {
    name: 'agent-trace-transcript-api',
    configureServer: handle,
    configurePreviewServer: handle,
  };
}

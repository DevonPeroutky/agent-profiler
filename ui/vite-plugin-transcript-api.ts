// Node-only Vite plugin. Do NOT import from ui/src/ — uses node:fs.

import type { Plugin } from 'vite';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .js module with @ts-check JSDoc types, typechecked separately
import { tracesHandler } from '../lib/traces/api-handler.js';

export function transcriptApi(): Plugin {
  return {
    name: 'agent-trace-transcript-api',
    configureServer(server) {
      server.middlewares.use('/api/traces', tracesHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/traces', tracesHandler);
    },
  };
}

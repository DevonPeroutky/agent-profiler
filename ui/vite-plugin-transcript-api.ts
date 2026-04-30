// Node-only Vite plugin. Do NOT import from ui/src/ — uses node:fs.

import type { Plugin } from 'vite';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .js module with @ts-check JSDoc types, typechecked separately
import { tracesHandler, transcriptHandler } from '../lib/traces/api-handler.js';

export function transcriptApi(): Plugin {
  return {
    name: 'agent-trace-transcript-api',
    configureServer(server) {
      server.middlewares.use('/api/traces', tracesHandler);
      server.middlewares.use('/api/transcript', transcriptHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/traces', tracesHandler);
      server.middlewares.use('/api/transcript', transcriptHandler);
    },
  };
}

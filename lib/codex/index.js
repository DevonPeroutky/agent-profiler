// @ts-check
// Codex CLI harness adapter. Reads $CODEX_HOME/sessions/YYYY/MM/DD/rollout-
// *.jsonl (CODEX_HOME defaults to ~/.codex) and emits TraceSummary[] via
// the pure transformer in ./traces.js.

import { listSessions } from './sessions.js';
import { toTraces } from './traces.js';
import { readTranscript } from './transcripts.js';

/** @typedef {import('../adapters/types.d.ts').HarnessAdapter} HarnessAdapter */
/** @typedef {import('./transcripts.js').CodexBundle} CodexBundle */

/** @type {HarnessAdapter} */
export const codex = {
  id: 'codex',
  discover() {
    return listSessions();
  },
  read(file) {
    return readTranscript(file);
  },
  transform(sessionId, bundle) {
    return toTraces(sessionId, /** @type {CodexBundle} */ (bundle));
  },
};

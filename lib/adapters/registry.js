// @ts-check
// Adapter registry. The single source of truth for which harnesses the
// profiler can ingest. Adding a new harness:
//
//   1. Create `lib/<harness-id>/{sessions,transcripts,traces,index}.js`.
//   2. Implement discover() / read() / transform() per types.d.ts.
//   3. Append the exported adapter object to ADAPTERS below.
//
// Nothing else (store, api-handler, UI) needs to change.

import { claudeCode } from '../claude-code/index.js';

/** @typedef {import('./types.d.ts').HarnessAdapter} HarnessAdapter */
/** @typedef {import('./types.d.ts').SessionFile} SessionFile */
/** @typedef {import('../claude-code/traces.js').TraceSummary} TraceSummary */

/** @type {HarnessAdapter[]} */
export const ADAPTERS = [claudeCode];

/** @returns {HarnessAdapter[]} */
export function enumerate() {
  return ADAPTERS;
}

/**
 * @param {string} id
 * @returns {HarnessAdapter | null}
 */
export function byId(id) {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/**
 * Run an adapter's transform and stamp invariants the registry guarantees:
 *
 *  - `agent_trace.harness` is set on every trace root (overwrites any value
 *    the adapter wrote — trust nothing).
 *  - `traceId` is prefixed `${adapter.id}:` so cross-harness collisions on
 *    raw session UUIDs cannot reach React keys / routing.
 *
 * Idempotent: calling it on traces that were already prefixed would double-
 * prefix, so callers must run it exactly once per transform() result. The
 * store does this naturally because cached traces are stored post-stamping.
 *
 * @param {HarnessAdapter} adapter
 * @param {string} sessionId
 * @param {unknown} bundle
 * @returns {TraceSummary[]}
 */
export function runTransform(adapter, sessionId, bundle) {
  const traces = adapter.transform(sessionId, /** @type {any} */ (bundle));
  for (const t of traces) {
    t.root.attributes['agent_trace.harness'] = adapter.id;
    t.traceId = `${adapter.id}:${t.traceId}`;
  }
  if (process.env.NODE_ENV !== 'production') {
    for (const t of traces) {
      if (t.root.attributes['session.id'] !== t.sessionId) {
        console.warn(
          `[adapter:${adapter.id}] session.id mismatch on traceId=${t.traceId}: ` +
            `attribute=${String(t.root.attributes['session.id'])} top-level=${t.sessionId}`,
        );
      }
    }
  }
  return traces;
}

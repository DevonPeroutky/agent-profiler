// @ts-check
// Multi-harness cache. Routes through the adapter registry. Cache keys are
// `${harness}:${sessionId}` so two harnesses can't poison each other's entries
// (UUID collisions across harnesses are vanishingly unlikely but the tuple
// key makes them impossible).
//
// Invalidation rule: if (mtimeMs, sizeBytes) changed, re-parse. Both fields
// are opaque to the store — adapters may stuff any monotonic values.

import { enumerate, runTransform } from '../adapters/registry.js';

/** @typedef {import('../adapters/types.d.ts').HarnessAdapter} HarnessAdapter */
/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */
/** @typedef {import('./types.js').TraceSummary} TraceSummary */

/** @type {Map<string, { mtimeMs: number, sizeBytes: number, traces: TraceSummary[] }>} */
const cache = new Map();

/**
 * @param {string} harness
 * @param {string} sessionId
 * @returns {string}
 */
function cacheKey(harness, sessionId) {
  return `${harness}:${sessionId}`;
}

/**
 * Compute (or cache-serve) TraceSummary[] for one session of one adapter.
 * @param {HarnessAdapter} adapter
 * @param {SessionFile} file
 * @returns {TraceSummary[]}
 */
export function getTracesForFile(adapter, file) {
  const key = cacheKey(adapter.id, file.sessionId);
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
    return cached.traces;
  }
  const bundle = adapter.read(file);
  const traces = runTransform(adapter, file.sessionId, bundle);
  cache.set(key, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
    traces,
  });
  return traces;
}

/**
 * Merge sessions across every registered adapter, sort by mtime desc, cap to
 * `limit`, then resolve each through the cache. The cap is global (not per
 * harness) so user-facing semantics stay "N most-recent conversations across
 * all agent tools."
 *
 * Also returns a `version` fingerprint over the served slice so polling
 * clients can short-circuit when nothing has changed. The fingerprint is
 * `count:maxMtime:totalSize`: any add, remove, or modification of a session
 * in the slice changes at least one component.
 *
 * @param {number} limit
 * @returns {{ traces: TraceSummary[], version: string }}
 */
export function getAllTraces(limit) {
  /** @type {Array<{ adapter: HarnessAdapter, file: SessionFile }>} */
  const all = [];
  for (const adapter of enumerate()) {
    for (const file of adapter.discover()) {
      all.push({ adapter, file });
    }
  }
  all.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  const top = all.slice(0, limit);

  let maxMtime = 0;
  let totalSize = 0;
  for (const { file } of top) {
    if (file.mtimeMs > maxMtime) maxMtime = file.mtimeMs;
    totalSize += file.sizeBytes;
  }
  const version = `${top.length}:${maxMtime}:${totalSize}`;

  const traces = top.flatMap(({ adapter, file }) => getTracesForFile(adapter, file));
  return { traces, version };
}

export { cache as _cache };

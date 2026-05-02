// @ts-check
// mtime+size keyed cache for parsed TraceSummary arrays. Module-scope Map,
// no locks — the transformer is pure and the Node event loop gives us
// atomicity for map mutations.
//
// Invalidation rule: if the main transcript's (mtime, size) changed, re-parse.
// No other invalidation. If a subagent file changes but the main file hasn't,
// we keep the cached value — acceptable because subagent edits by Claude Code
// always accompany a write to the main transcript in the same turn.

import { listSessions } from './sessions.js';
import { toTraces } from './traces.js';
import { readTranscript } from './transcripts.js';

/** @typedef {import('./sessions.js').SessionFile} SessionFile */
/** @typedef {import('./traces.js').TraceSummary} TraceSummary */

/** @type {Map<string, { mtimeMs: number, sizeBytes: number, traces: TraceSummary[] }>} */
const cache = new Map();

/**
 * Compute TraceSummary[] for one session, serving the cached value when
 * (mtime, size) of the main transcript hasn't changed.
 * @param {SessionFile} file
 * @returns {TraceSummary[]}
 */
export function getTracesForFile(file) {
  const cached = cache.get(file.sessionId);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
    return cached.traces;
  }
  const traces = toTraces(file.sessionId, readTranscript(file));
  cache.set(file.sessionId, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
    traces,
  });
  return traces;
}

/**
 * List all sessions, parse each (cached), and flatten. Caller picks the limit.
 * @param {number} limit
 * @returns {TraceSummary[]}
 */
export function getAllTraces(limit) {
  const files = listSessions().slice(0, limit);
  return files.flatMap((f) => getTracesForFile(f));
}

export { cache as _cache };

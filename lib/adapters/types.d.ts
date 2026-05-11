// Adapter contract shared across all harness adapters.
//
// `SessionFile` is the per-session handle returned by `discover()`. The
// registry treats `mtimeMs` and `sizeBytes` as opaque cache-key components —
// any monotonic value works (a SQLite-backed harness could stuff `lastRowId`
// in `mtimeMs`). The store only checks that the pair changed.
//
// `HarnessAdapter<TBundle>` is the contract every adapter must satisfy. The
// `TBundle` type is adapter-internal: Claude Code's is `{main, subagents}`,
// Codex's is `{rows}`, etc. The registry treats it as `unknown`.
//
// Obligations every adapter honors:
// 1. `discover()` returns SessionFile[] sorted mtime desc, sessionId asc
//    tiebreaker (stability across platforms).
// 2. `read()` is the only file-I/O surface. Must tolerate live writes
//    (torn-line drop + per-record try/catch). Mid-call ENOENT may throw —
//    the store catches.
// 3. `transform()` is pure and deterministic. No timestamps used for any
//    identity / pairing / ordering decision (CLAUDE.md §2). Returning [] on
//    a malformed bundle is legal; do not throw.
// 4. Trace roots SHOULD stamp `attributes['agent_trace.harness']`. The
//    registry stamps it defensively after transform() regardless.
// 5. `traceId` is deterministic and stable within a harness. The registry
//    prefixes `${harness}:` after transform() returns so cross-harness
//    collisions are impossible.

import type { TraceSummary } from '../traces/types.js';

export interface SessionFile {
  /** Adapter id of the session. Set by registry/discover. */
  harness: string;
  /** Raw session id (UUID untouched). */
  sessionId: string;
  /** Primary transcript path. Opaque to the registry. */
  mainPath: string;
  /** Opaque cache-key component — any monotonic value. */
  mtimeMs: number;
  /** Opaque cache-key component — any monotonic value. */
  sizeBytes: number;
  /** Adapter-internal extras (paired files, sidecars, etc.). */
  extras?: Record<string, unknown>;
}

export interface HarnessAdapter<TBundle = unknown> {
  /** Unique id (e.g. `'claude-code'`, `'codex'`). */
  id: string;
  /** Walk disk; return discoverable sessions sorted mtime desc, sessionId asc tiebreaker. */
  discover(): SessionFile[];
  /** Read the session's raw transcript bundle. Adapter-internal shape. */
  read(file: SessionFile): TBundle;
  /** Pure transform from bundle to TraceSummary[]. */
  transform(sessionId: string, bundle: TBundle): TraceSummary[];
}

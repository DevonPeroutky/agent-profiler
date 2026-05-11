# Adding an Agent Harness Adapter

This guide explains the adapter architecture, the interface boundary every adapter must honor, and the concrete steps to contribute support for a new local agent harness (e.g. a new CLI like Aider, Cline, or an in-house tool).

For the larger pipeline and the cross-cutting invariants the transformer must obey, start with [ARCHITECTURE.md](../ARCHITECTURE.md). This document focuses specifically on the adapter seam.

---

## Overview

agent-profiler reads local session transcripts from disk and renders them as a span-tree waterfall. Different agent harnesses (Claude Code, Codex CLI, …) write their transcripts in different on-disk formats, but the UI consumes a single normalized shape — `TraceSummary[]`.

**An adapter is the bridge between one harness's on-disk format and the shared trace topology.** It owns three responsibilities:

1. **Discover** sessions on disk.
2. **Read** one session's raw bytes into an adapter-private bundle.
3. **Transform** that bundle into `TraceSummary[]`.

Once an adapter is registered, the cache (`lib/traces/store.js`), the HTTP handlers (`lib/traces/api-handler.js`), and the React app pick it up automatically — they're all harness-agnostic.

```
on-disk transcripts                shared trace shape
─────────────────                  ──────────────────
~/.claude/projects/…   ─┐
                        │
$CODEX_HOME/sessions/…  ─┼──► adapter registry ──► store (cache) ──► /api/traces ──► UI
                        │
<new harness path>      ─┘
```

---

## The interface boundary

The full contract is in [`lib/adapters/types.d.ts`](../lib/adapters/types.d.ts). The summary:

```ts
interface SessionFile {
  harness: string;       // adapter id; set by the registry
  sessionId: string;     // raw session id, untouched
  mainPath: string;      // primary transcript path; opaque to the registry
  mtimeMs: number;       // opaque cache-key component (any monotonic value)
  sizeBytes: number;     // opaque cache-key component (any monotonic value)
  extras?: Record<string, unknown>;  // adapter-internal extras
}

interface HarnessAdapter<TBundle = unknown> {
  id: string;                                                       // unique, e.g. 'claude-code'
  discover(): SessionFile[];                                        // walk disk
  read(file: SessionFile): TBundle;                                 // I/O — adapter-private shape
  transform(sessionId: string, bundle: TBundle): TraceSummary[];    // pure
}
```

### `TBundle` is adapter-private

The registry treats `TBundle` as `unknown`. Claude Code's is `{ main, subagents }`; Codex's is `{ rows }`. Only the adapter's own `read` and `transform` ever see the shape. New adapters are free to pick whatever bundle shape best fits their source format.

### Cache keys are opaque

`mtimeMs` and `sizeBytes` are *only* used by the store as a change-detection tuple. They don't have to come from `fs.stat`. A SQLite-backed harness could stuff `lastRowId` in `mtimeMs` and `0` in `sizeBytes` — as long as the pair changes when the session changes, the cache works correctly.

### The registry enforces two invariants, so adapters don't have to

[`runTransform`](../lib/adapters/registry.js) stamps every emitted trace root with:

- `attributes['agent_trace.harness'] = adapter.id` (overwritten defensively — adapters don't need to set it).
- `traceId = \`${adapter.id}:${traceId}\`` (prefixed so two harnesses can't collide on raw session UUIDs).

Adapters MUST NOT pre-prefix their `traceId` values themselves — `runTransform` is the single point where this happens.

---

## Why `read` and `transform` are split

A natural question is "why not collapse this into a single `file → TraceSummary[]` function?" The seam exists for four concrete reasons:

1. **The Debug tab consumes the raw bundle.** `transcriptHandler` in `lib/traces/api-handler.js` returns `adapter.read(file)` directly to power the UI's "show me the raw rows" view. Splitting read from transform gives both the trace API and the transcript API a clean place to hook in.

2. **Test fixtures live at the bundle boundary.** Because `transform()` is pure, transformer tests construct `TBundle` literals directly — no `tmpfile`, no `fs` mocking. This matters because the transformer is where the subtle invariants live (no timestamps for identity decisions, inference-vs-tool-call accounting).

3. **Read tolerance and read-boundary filters get isolated.** `read()` must tolerate live writes (torn trailing line, per-record try/catch, silent on bad lines). Adapters may also apply read-boundary *filters* — Codex strips its 10 KB `base_instructions.text` and replayed user/developer messages. Isolating these in `read()` means the transformer can assume filtered input and stay pure.

4. **The cache can route on a cheap probe.** `discover()` produces the `(mtimeMs, sizeBytes)` tuple without ever opening the file. The store consults the cache before `read` or `transform` runs.

The cost of the seam is small — one extra typedef per adapter and one extra function. The Codex adapter is 25 lines.

---

## Rules every adapter must self-enforce

These are not enforced by types — they're contractual obligations called out in `lib/adapters/types.d.ts` and in [ARCHITECTURE.md / CLAUDE.md](../CLAUDE.md). Violating them produces subtly broken traces that pass naive tests.

### `discover()`

- Returns `SessionFile[]` sorted **mtime desc, sessionId asc** as tiebreaker. The tiebreaker matters because `readdir` order is not guaranteed across platforms and the UI surfaces "most recent first."
- No I/O beyond stat-level metadata. Never parse a transcript here.

### `read()`

- This is the **only** file-I/O surface in the adapter.
- Must tolerate concurrent writes: the file may be appended while you're reading.
  - Drop any trailing chunk that doesn't end in `\n` (torn write).
  - Per-record `try/catch` — one bad line never fails the whole session.
  - Silent on skipped lines. The read path is hot; noise isn't useful.
- Mid-call `ENOENT` may throw; the store catches.
- Apply read-boundary filters here when the source format includes content the transformer should never see (system prompts, replayed harness-injected messages, etc.). Centralize them so test fixtures and real bundles agree on what "filtered" means.

### `transform()`

- **Pure and deterministic.** No I/O. No time-of-day dependence. Same input → same output.
- **Never use a timestamp for any identity / pairing / ordering / grouping decision.** This is absolute, no exceptions — see [CLAUDE.md §2](../CLAUDE.md). The legitimate uses of a timestamp are:
  - Computing `durationMs` for an already-paired `(tool_use, tool_result)` whose pairing was established structurally.
  - Sorting events on a single span for display order.
  - Rendering relative time strings in the UI.
- Anything else (nearest-neighbor, time-windowing, "within 5ms of," ordering by timestamp) is forbidden. Pair via structural links only: parent chains, ids, sidecar files, filename layout. If no structural link exists, emit the orphan as `kind: 'unattached'` rather than guessing.
- Returning `[]` on a malformed bundle is legal; do not throw.

### Trace topology

Every adapter must produce traces that fit the shared topology. See [CLAUDE.md §5](../CLAUDE.md) for the full description; the essentials:

- **One trace per turn** (`kind: 'turn'`), optionally one `kind: 'unattached'` trace for orphans.
- **One `inference` span per API round-trip.** An "inference" = one remote API call that costs money. Local tool executions are *not* inferences; they are child spans of the inference that emitted them. Tool calls inside an assistant response do not multiply the inference count.
- **`traceId`** is deterministic and stable within the adapter (e.g. `${sessionId}:turn:${n}`). The registry adds the `${harness}:` prefix.
- **`session.id`** attribute on each trace root must equal the top-level `sessionId`.
- **Per-turn token totals** as `agent_trace.turn.{input,output,cache_read,cache_creation}_tokens`.
- **Assistant content** attaches as events on the inference span: `gen_ai.assistant.message` for visible text, `gen_ai.assistant.reasoning` for extended-thinking content. Tool calls become child spans, not events.
- **No zero-duration marker spans.** The user prompt is the `agent_trace.prompt` attribute on the turn root, not a sibling span.

---

## Contribution checklist

To add support for a new harness `<id>` (e.g. `aider`, `cline`, `gemini-cli`):

### 1. Data layer

Create `lib/<id>/` with four files mirroring the existing adapters:

| File | Responsibility |
|------|----------------|
| `sessions.js` | Walk the harness's on-disk layout. Export `listSessions()` returning `SessionFile[]` sorted mtime desc, sessionId asc. |
| `transcripts.js` | `readJsonl`-style I/O with torn-line tolerance. Export `readTranscript(file): TBundle`. Apply any read-boundary filters here. |
| `traces.js` | Pure transformer producing `TraceSummary[]`. Export `toTraces(sessionId, bundle)`. This is where the subtle invariants live — read CLAUDE.md before writing this file. |
| `index.js` | Export the `HarnessAdapter` object that wires the three together. Should be ~25 lines. |

Reference the existing Claude Code (`lib/claude-code/`) and Codex (`lib/codex/`) adapters. Codex is the leaner, more recent example.

### 2. Registry

Append the adapter to `ADAPTERS` in [`lib/adapters/registry.js`](../lib/adapters/registry.js):

```js
import { myHarness } from '../<id>/index.js';

export const ADAPTERS = [claudeCode, codex, myHarness];
```

This is the single touch point in the data layer.

### 3. UI metadata

Add a `REGISTRY` entry in [`ui/src/lib/harnesses.tsx`](../ui/src/lib/harnesses.tsx) keyed by the adapter `id`:

```ts
'<id>': {
  displayName: 'My Harness',
  logoSrc: '/images/<id>-logo.svg',
  invertOnDark: true,  // only if the logo is monochrome black-on-transparent
},
```

Drop the logo asset under `ui/public/images/`. **Tight-crop the asset** — viewBox (SVG) or raster dimensions should hug visible geometry; the renderer doesn't compensate for baked-in padding, so a padded asset will look undersized next to other logos.

This is the only UI change required. Chat rows, sidebar avatars, and trajectory headers all read `trace.root.attributes['agent_trace.harness']` and look up here.

### 4. Tests

At minimum:

- **Discovery test**: fake on-disk layout under a tmp dir, assert `discover()` returns the expected `SessionFile[]` order.
- **Read tolerance test**: a transcript missing its final `\n`, a transcript with one bad JSON line — both must yield usable bundles without throwing.
- **Transformer fixture tests**: construct `TBundle` literals (no disk I/O) and assert the produced `TraceSummary[]` matches expected topology. Cover at least: a turn with no tool calls, a turn with tool calls, an error case, token-usage totals.

### 5. Local contract

Adapters must keep the same local-only posture as the rest of agent-profiler: read local files on demand, no background collectors, no network calls, never send transcript data off the machine. The user's transcripts stay in their `~/`.

---

## Checklist before opening a PR

- [ ] `discover()` sorts mtime desc, sessionId asc tiebreaker.
- [ ] `read()` survives a torn trailing line and a malformed record without throwing.
- [ ] `transform()` is pure (no `fs`, no `Date.now`, no `Math.random` outside span-id generation).
- [ ] No timestamps used for pairing, ordering, identity, or grouping decisions anywhere in `transform()`.
- [ ] Every emitted trace has `session.id` matching its `sessionId`.
- [ ] `traceId` is deterministic within the adapter, **not** pre-prefixed with the harness id.
- [ ] Inference count equals the number of distinct API round-trips, not the number of content blocks or tool calls.
- [ ] No zero-duration marker spans.
- [ ] UI registry entry added with a tight-cropped logo.
- [ ] Test fixtures cover read tolerance and at least one tool-call turn.

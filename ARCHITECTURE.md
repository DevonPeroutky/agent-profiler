# Architecture

How agent-profiler turns Claude Code's on-disk session transcripts into the waterfall you see in the UI.

For installation and day-to-day usage, see [README.md](./README.md). For the exhaustive contract that every change to the transformer must respect, see [CLAUDE.md](./CLAUDE.md). This document is the bridge: a conceptual overview anyone can read, plus an implementation map for maintainers editing the trace pipeline.

---

## Part 1 — Conceptual overview

### What it does

- Discovers every Claude Code session transcript on your machine: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`.
- Reads paired subagent transcripts at `<sessionId>/subagents/agent-<agentId>.jsonl` and nests them under the tool call that spawned them.
- Renders a trace waterfall — tool durations, prompts, per-turn token totals, span-level detail.
- Polls every 5 seconds. Live sessions update as Claude Code writes new messages to disk.

Stateless and deterministic. Restart any time.

### Two run modes, one pipeline

```
~/.claude/projects/<project-slug>/
    <sessionId>.jsonl                ◄── main conversation transcript
    <sessionId>/subagents/
      agent-<agentId>.jsonl          ◄── subagent sidechain
      agent-<agentId>.meta.json
                │
                ▼
┌──────────────────────────────────────────────┐
│  Production: bin/agent-profiler.js           │   one Node process
│  Dev/preview: ui/vite-plugin-transcript-api  │   Vite middleware
│                                              │
│   /api/traces  ──►  tracesHandler            │
│                       └─► getAllTraces()     │
│                            └─► getTracesForFile()
│                                 ├─► readTranscript()   (lib/traces/transcripts.js)
│                                 └─► toTraces()         (lib/traces/traces.js)
│                                                        └─► TraceSummary[]
└──────────────────────────────────────────────┘
                                                │
                                                ▼
                                       React UI at /
```

Both run modes share `lib/traces/api-handler.js`. Production additionally serves the built UI from `ui/dist/` and exposes `/api/health`; Vite serves the React dev bundle and skips health.

### Endpoints

| Endpoint | Method | Purpose | Available in |
| --- | --- | --- | --- |
| `/` | GET | Single-page UI | both |
| `/api/traces` | GET | Trace tree for the most-recent sessions under `~/.claude/projects/` (capped at `AGENT_TRACE_LIMIT`, default 200) | both |
| `/api/transcript?sessionId=…` | GET | Raw JSONL bundle for one session — used by the Debug tab | both |
| `/api/health` | GET | `{ ok, version, sessionCount, uptimeSeconds }` | production only |

`tracesHandler` ignores the HTTP method, so `POST` works too — but document and call as `GET`.

### Verifying it works

```bash
agent-profiler --port 7777 --no-open &
curl -s http://localhost:7777/api/health | jq
curl -s http://localhost:7777/api/traces | jq '.traces | length'
```

A non-zero trace count means you've used Claude Code recently and the pipeline is healthy.

### Trace topology

One trace per turn — OTel-conventional. The session is an attribute (`session.id`) on each trace root, not a wrapping span. Conversations are a UI-side grouping of traces sharing a session id. `traceId` is deterministic (`${sessionId}:turn:${n}` or `${sessionId}:unattached`), so React keys stay stable across polls.

```
Trace { kind: 'turn', traceId: <sid>:turn:N }
  turn:N                     ← root; attrs: session.id, gen_ai.request.model, agent_trace.prompt, …
    inference                ← one per requestId; carries tokens, stop_reason, content events
      <ToolName>             ← tool_use + tool_result → duration
      Agent                  ← subagent-spawning tool
        subagent:<type>      ← nested subagent tree (linked via toolUseResult.agentId)
          <tools …>

Trace { kind: 'turn', traceId: <sid>:turn:N }   ← slash-command turn
  turn:N        prompt = "/cmd args"
    Skill                    ← synthesized from <local-command-caveat>/<stdout> triad
      subagent:<type>

Trace { kind: 'unattached', traceId: <sid>:unattached }   ← only when orphans exist
  subagents:unattached
    subagent:<type>          ← Skill-dispatched or otherwise unlinked
```

Two public trace kinds exist: `turn` and `unattached`. Slash-command turns reuse `kind: 'turn'`; the synthesized `Skill` span inside them is the only structural tell.

---

## Part 2 — Implementation map for maintainers

### File layout

```
lib/traces/
  sessions.js          listSessions() — discover session files on disk, sorted by mtime desc
  transcripts.js       readTranscript() — JSONL reader, tolerant of partial writes
  traces.js            toTraces() — pure transformer; all shaping logic lives here
  trace-filters.js     record-level filters (e.g. drop synthetic <task-notification> rows)
  store.js             mtime+size keyed cache; getAllTraces / getTracesForFile
  api-handler.js       tracesHandler / transcriptHandler — usable as raw or Connect middleware
bin/
  agent-profiler.js    Production CLI: HTTP server + static UI + /api/health
ui/
  vite-plugin-transcript-api.ts   Dev/preview middleware (mounts /api/traces, /api/transcript)
  src/                            React app — pure view layer, never imports lib/traces/*
  src/lib/trace-filters.ts        Span-level counterpart to lib/traces/trace-filters.js
```

Server-side code is JavaScript with `// @ts-check` JSDoc; the UI is TypeScript. The boundary is enforced by directory: anything under `ui/src/` runs in the browser and must not touch `node:fs`.

### Three invariants worth promoting

These are the rules most often violated by drive-by changes. The exhaustive list lives in [CLAUDE.md](./CLAUDE.md); these three are the highest-leverage to internalize before touching `traces.js`.

**1. Inference vs. tool call.** An *inference* is a single Anthropic API round-trip, identified by `requestId`. A *tool call* (`tool_use` content block) is local execution — Bash, Read, Edit — that runs *between* inferences. One inference can emit zero, one, or many tool calls; each becomes its own child span. Tool calls are never inferences. Conflating them inflates request counts and misattributes cost. The state layer mirrors API round-trips 1:1: one `inference` span per distinct `requestId` within a slice, regardless of what content kinds the response contained.

**2. No timestamps in pairing decisions.** Subagent placement, parent/child relationships, attachment, dedupe — all of it must use structural links only (`parentUuid`, `toolUseResult.agentId`, `tool_use_id`, `sessionId`, on-disk filenames). Timestamps describe flush order, not causal order; in slash-command sessions they're often identical across causally-distant records. Timestamps are display-only — fine for `durationMs` of an already-paired `(tool_use, tool_result)` and for stable-sorting events on a single span. Anything else is forbidden.

**3. Three subagent spawn pathways.** The transformer handles each one structurally:

- **Explicit Agent/Task tool_use** — the main transcript's `tool_result` carries `toolUseResult.agentId`, exact-matching the subagent filename. Nest under the `Agent` span.
- **Skill dispatched from a text prompt** — same pairing path as Agent/Task; span name is `Skill`.
- **Slash-command Skill dispatch** — the main transcript contains a `<local-command-caveat>` → `/cmd args` → `<local-command-stdout>` triad linked by `parentUuid`. No `agentId` on the result. Collapse into one slash-turn slice and synthesize a `Skill` span. If the session has exactly one slash triad, attach unpaired sidechain subagents to that `Skill` (1:1 by construction). Multiple triads with no structural link? Leftover subagents fall through to the `unattached` trace.

### Token attribution

Every turn root and every `subagent:<type>` span carries token aggregates deduped by `requestId` — a single API response emits multiple JSONL rows with identical `usage`, and summing per row inflates totals 2-3×. `dedupeUsagesByRequestId` in `lib/traces/traces.js` sums each distinct request exactly once. The same predicate (`isCanonicalAssistantRecord`) gates both inference emission and dedupe, so `inferences.length === turn.request_count` by construction.

| Granularity | Captured directly |
| --- | --- |
| Per turn | input / output / cache_read / cache_creation / context / request_count |
| Per subagent | input / output / cache_read / cache_creation / request_count |
| Per inference | one span per `requestId` carrying `agent_trace.inference.request_id` and that request's `usage` |
| Per tool call | not directly recoverable — cost lands inside the *next* inference's `cache_creation_input_tokens` |
| Per skill / user prompt | not directly recoverable — same mechanism as per-tool |

### Pure-transformer boundary

`toTraces(sessionId, bundle)` takes parsed records and returns `TraceSummary[]`. No I/O, no time-of-day dependence, same input → same output. All shaping (turn slicing, subagent pairing, token aggregation, attribute naming) lives in `traces.js`. The Vite middleware and the JSONL reader do nothing but I/O. If you ever want OTLP export, write a one-shot `transcript → OTLP JSONL` script — `toTraces` already gives you everything.

### Stateless cache

`store.js` keys on `(sessionId → mtimeMs + sizeBytes)` in a module-scope `Map`. If `stat` says the main transcript changed, re-parse; otherwise serve the cached `TraceSummary[]`. No locks — the transformer is pure and Node's event loop gives us atomicity for `Map` mutations. Cap is `AGENT_TRACE_LIMIT` (default 200) most-recent sessions. Subagent edits without a main-file write are tolerated as stale until the next main-file write — Claude Code always writes both in the same turn.

### Read tolerance

`readJsonl` survives being run while Claude Code is appending: trailing chunks without `\n` are dropped (partial write), and each line is parsed in its own try/catch so one bad record can't fail the session. No warnings — the read path is hot and noise isn't useful. Each parsed record is stamped with `_rowIndex` (0-based parse order), which the Debug tab uses for its `#N` numbering.

### Cross-slice invariants

`toTraces` iterates turn slices sequentially. Three accumulators are shared across all slices and parallelizing would silently break them:

- `subagentsById` — drained as `Agent`/`Task`/`Skill` tool_results consume them; the remainder becomes the `unattached` trace.
- `slashTurns` — collected during the loop; `attachSlashSubagents` runs after to nest sidechains into the single-triad case.
- `sideCtx.initialPermissionModeSet` — capture-once, stamped onto every trace root as `agent_trace.session.initial_permission_mode`.

### Pre-first-turn content

Hooks (e.g. `hook:SessionStart`) emitted before turn 1 with `durationMs > 0` relocate onto turn 1's root. Zero-duration hooks remain as events. Files with pre-turn content but zero turns drop the content — there's no root to attach it to.

### Things that aren't captured

- Anything you haven't conversed about in Claude Code. Transcripts are the only input.
- Server-side timings that aren't in the transcript (exact network latency, rate-limit delays). Tool durations are wall-clock between `tool_use` and `tool_result` timestamps.

### Things that aren't built (deliberately)

- **OTLP export or any external collector.** The transformer is pure — a one-shot script is ~30 lines if you ever need it.
- **Hooks or live push.** Hooks are fragile (undocumented `matcher`, slash commands skip `UserPromptSubmit`, adapter bugs drop `agent_id`). Transcripts are complete and stable. The 5s poll is intentional.
- **Cross-session comparison views, alerting, remote collectors.**
- **Harness-agnostic abstraction.** Current scope is Claude Code only.

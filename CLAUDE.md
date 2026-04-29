# agent-profiler

A local trace viewer for Claude Code conversations. Reads session transcripts directly from disk and renders them as a span-tree waterfall. A React + Vite app with a small middleware plugin — no separate server process, no hooks, no OTEL SDK.

## Communication style

Speak simply and explain things clearly. Avoid jargon — when a domain term is genuinely necessary (e.g. `requestId`, `tool_use`), define it the first time it appears in a response. Prefer plain-English descriptions over acronyms and library-internal naming. If a concept can be explained with a short sentence instead of a technical label, use the sentence.

## North Star

**Claude Code's own per-session JSONL transcripts (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`) are the source of truth.** The viewer is a pure `(transcript → SpanNode tree → JSON)` pipeline. If the UI and the raw transcript disagree about what happened, the transcript is right.

## Core vocabulary — inference vs. tool call

These two are not the same thing. Confusing them is the largest recurring source of bugs in this transformer.

**Inference.** A single request to the remote Anthropic API. Something that costs money, takes wall-clock time, and ends with the model returning a response. Has a `requestId` — one per API round-trip. Whatever content the model returned (thinking, text, tool_use, or any combination) belongs to that one inference and shares its `requestId`. **The state layer mirrors API round-trips 1:1: one `inference` span per distinct `requestId` within a slice**, regardless of what content kinds the response contained. A response with `[thinking, text, tool_use]` is one inference, not three. *How* that inference is rendered (waterfall bar, chat bubble, both, neither) is a UI decision driven by `has_*` flags and the events list — the state layer is content-kind-agnostic.

The canonical predicate for "an assistant record that counts" is `isCanonicalAssistantRecord` (`type === 'assistant'`, `!isApiErrorMessage`, has `message.usage`, has non-empty `requestId`). It gates both the inference emitter *and* token dedupe (`dedupeUsagesByRequestId` in `lib/traces/traces.js`) — `inferences.length` equals `agent_trace.turn.request_count` by construction. Drift here recreates the count discrepancy on any turn with API errors.

**Tool call (`tool_use` content block).** Local execution on the user's machine — Bash, Read, Edit, Glob, Grep, etc. **Tool calls are not inferences.** They are produced *inside* an assistant response as a content block, but executing them is local — the agent harness runs the command, captures the result, and feeds it back into the *next* inference as added context. A `tool_use` block carries a `requestId` because the inference that emitted it had one; that does not make the local execution itself an API round-trip. A single inference can emit zero, one, or many `tool_use` blocks; each one becomes its own tool span (duration `tool_result.ts − tool_use.ts`), parented under the inference that emitted it.

**Tool result.** A `user` JSONL record whose `message.content` contains `tool_result` blocks is the *output* of one or more tool executions. It has no `requestId` of its own (no API call happened). It is paired to its `tool_use` via `tool_use_id`. Tool results are not inferences either; they are the *input* that the next inference reads.

**Why this matters.** Conflating tool calls with inferences inflates inference counts and misattributes cost. The user mental model — "how many times did we call the model?" — is exactly `requestId`-count. Tool calls happen between inferences; they shape the prompt for the *next* inference but are never themselves inferences.

**In the transcript.**

- An `assistant` JSONL record carries `requestId`. The record's `message.content` is an array of content blocks (`text`, `thinking`, `tool_use`, …). Claude Code flushes each content block as its own JSONL row, so one API response ≈ N consecutive assistant records sharing one `requestId`.
- A `user` JSONL record with `tool_result` content is the local execution output. No `requestId`. Pairs to its `tool_use` via `tool_use_id`.

**Inference span shape.** Rows of the same `requestId` are aggregated into one span: `usage` is taken once (identical across rows), `stop_reason` from the row that carries it, and the union of content-block types determines the `agent_trace.inference.has_*` booleans (`has_thinking`, `has_text`, `has_tool_use`). Content payloads attach as OTel-semconv events on the inference span — `gen_ai.assistant.reasoning` and `gen_ai.assistant.message` — emitted iff non-empty after truncation.

**`agent_trace.inference.prompt` semantics.** Populated by walking backward from the *first* assistant row of the `requestId` group through non-assistant records (typically `tool_result` records and user input) until the prior assistant row. The prompt represents the context that triggered this inference — including any tool_result content that arrived since the last inference. One prompt per inference span; the key is omitted when the walk yields no content.

**Anti-patterns (do not ship):**

- Emitting more than one `inference` span per `requestId`, or emitting one for a `tool_use` block in isolation. A `tool_use` is part of the inference that emitted it; the local execution gets a separate tool span.
- Counting tool spans in any "inference" total (or vice versa) — different units. Same for `turn.toolCount`.
- Re-introducing `gen_ai.assistant.message` / `gen_ai.assistant.reasoning` events on the turn root for content that belongs to a specific `requestId` — those events live on the inference span.
- Double-counting `usage` tokens by summing across every assistant row (use `requestId` dedupe).
- Labeling inference spans with `tool_use` (`stop_reason: tool_use` is legitimate but the *span name* must remain `inference`).
- Using timestamps anywhere in the transformer beyond computing `durationMs` from a structurally-paired `(tool_use, tool_result)` or stable-sorting events on a single span for display. See §2.

## Design principles

### 0. Simplicity over completeness. Prioritize the waterfall UI above all.

### 1. The transformer is pure and deterministic

- `lib/traces/traces.js#toTraces(sessionId, bundle)` takes parsed records and returns `TraceSummary[]` — one trace per turn, plus an optional `unattached` trace when Skill-dispatched subagents have no paired tool_use. No I/O. No time-of-day dependence. Same input → same output.
- All shaping (turn slicing, subagent pairing, token aggregation, attribute naming) lives here.
- The Vite middleware (`ui/vite-plugin-transcript-api.ts`) and the reader (`lib/traces/transcripts.js`) do nothing but I/O. The transformer does nothing but transform.

### 2. Deterministic subagent pairing

**Ingestion rule — absolute, no exceptions. Timestamps are display-only.**

> **Never** use a transcript timestamp — `timestamp`, `ts`, derived `startMs`/`endMs`, ordering, ranges, deltas, or *any* field whose value comes from a wall-clock — to make **any** ingestion, parsing, pairing, routing, grouping, identity, parent/child, sibling-precedence, attachment, dedupe, or unattached-vs-attached decision. Not "usually," not "as a tiebreaker," not "as a heuristic when the structural link is missing." Never. If you find yourself about to write `if (timestampA < timestampB)`, `findNearest(byTime)`, `withinWindow(ms)`, `sort(byTimestamp).then(pair…)`, or anything equivalent inside the transformer, stop — the answer is wrong even when it looks right.

Timestamps describe **flush order, not causal order**. In slash-command sessions they're written at end-of-command with identical-millisecond values, while the subagents they dispatched ran minutes earlier. Identical timestamps across causally-distant records are normal, not a bug. Containment checks, nearest-neighbor, time-windowing, and precedence ordering by timestamp are all traps — they *look* structural and silently produce wrong answers that pass tests on the fixtures you happened to write but break on real transcripts.

**The only legitimate uses of a timestamp:**
- Computing `durationMs` for an already-paired `(tool_use, tool_result)` whose pairing was established structurally via `tool_use_id`.
- Sorting events on a single span for *display* (chronological reading order in the UI), after the span itself was assembled structurally.
- Rendering a relative time string in the UI.

Anything else is forbidden. Pair via structural links only: `parentUuid` chain, `toolUseResult.agentId`, `promptId`, `sessionId`, `tool_use_id`, on-disk filename layout. If no structural link exists, admit defeat and emit the subagent as `kind: 'unattached'` — that variant exists precisely so you don't have to guess from timestamps.

- Claude Code writes subagent conversations to `<sessionId>/subagents/agent-<agentId>.jsonl`. Each one has a tiny `agent-<agentId>.meta.json` sidecar with `{agentType}`.
- Three spawn pathways exist and the transformer handles them:
  1. **Explicit Agent/Task tool_use** — the main transcript's `tool_result` record carries `toolUseResult.agentId`, exactly matching the subagent filename. Nest the subagent subtree under the `Agent` tool span.
  2. **Skill dispatched from a text prompt** — the main transcript has an assistant record with a `Skill` tool_use whose tool_result carries `toolUseResult.agentId`. Same pairing path as (1); the span name is `Skill` instead of `Agent`.
  3. **Slash-command Skill dispatch** — the main transcript contains the `<local-command-caveat>` → `/command args` → `<local-command-stdout>` triad, linked by `parentUuid` chain. No `toolUseResult.agentId` and no `promptId` are emitted. Collapse the triad into one `kind: 'slash'` turn slice and synthesize a `Skill` tool span inside it. If the session has **exactly one** slash triad, attach all unpaired subagents with `sessionId` match + `isSidechain: true` to that Skill span (1:1 by construction, deterministic, no timestamps). If the session has multiple slash triads with no structural subagent→triad link, leftover subagents fall through to `unattached` — admit defeat rather than guess.
- `unattached` is a first-class trace variant, not an error. It's the explicit safety valve for cases where no structural link exists.

### 3. Read tolerance

- `lib/traces/transcripts.js#readJsonl` must survive being run while Claude Code is appending. Two rules:
  - Drop any trailing chunk that doesn't end in `\n` (partial write).
  - Per-line try/catch — one bad record never fails the whole session.
- No warnings on skipped lines. The read path is hot; noise isn't useful.

### 4. Stateless server, mtime-keyed cache

- The Vite middleware holds no state of its own — no open spans, no session registry, no orphan sweep. Restart is a no-op.
- `lib/traces/store.js` keys on `(sessionId → mtimeMs + sizeBytes)` in a module-scope `Map`. Invalidation: `stat` says it changed, re-parse. Cap at `AGENT_TRACE_LIMIT` most-recent sessions (default 200).
- No locks. The transformer is pure; Node's event loop gives us atomicity on `Map` mutations.

### 5. Trace topology (what the UI gets)

One trace per turn — OTel-conventional. Session is an attribute (`session.id`) on each trace root, not a wrapping span. Conversations are a UI-side grouping of traces sharing a session id. `traceId` is deterministic: `${sessionId}:turn:${n}` or `${sessionId}:unattached`. React keys stay stable across polls.

```
Trace { kind: 'turn', traceId: <sid>:turn:N }
  turn:N
    inference                        one per requestId
      <ToolName>                     duration = tool_result.ts − tool_use.ts
      Agent                          subagent-spawning tool
        subagent:<agentType>
          inference
            <nested tool spans …>

Trace { kind: 'turn', traceId: <sid>:turn:N }   ← slash-command turn
  turn:N        prompt = "/cmd args"
    Skill       synthetic
      subagent:<agentType>

Trace { kind: 'unattached', traceId: <sid>:unattached }
  subagents:unattached
    subagent:<agentType>
```

See §2 for the rules governing subagent placement.

Pre-first-turn hooks (e.g. `hook:SessionStart`) with `durationMs > 0` relocate onto turn 1's root. Zero-duration hooks remain events (Principle 6). If a file has pre-turn content but zero turns, that content is dropped.

Attribute names: `session.id` (OTel semconv) + `agent_trace.prompt`, `agent_trace.tool.name`, `agent_trace.tool.input_summary`, `agent_trace.tool.output_summary`, `agent_trace.subagent.type`, `agent_trace.subagent.task`, `gen_ai.request.model`, plus per-turn `agent_trace.turn.{input,output,cache_read,cache_creation}_tokens`. Plugin-specific metadata lives under `agent_trace.*`; don't invent names that overlap with official OTel GenAI semconv.

Assistant output is captured as events on the **inference span** the content belongs to (one `inference` span per `requestId`). Two event names follow OTel GenAI semconv:

- `gen_ai.assistant.message` with `gen_ai.message.content` — visible text replies.
- `gen_ai.assistant.reasoning` with `gen_ai.reasoning.content` — extended-thinking reasoning.

Tool-call content is *not* a separate event — it produces a child tool span instead, parented under the inference that emitted the `tool_use` block. Empty/whitespace content events are dropped. Events on a span are stable-sorted by `timeMs` so readers see chronological order. Other event types (context attachments, hooks) continue to live on the turn root since they are not tied to a specific API call.

### 5a. Cross-slice invariants (do not parallelize)

`toTraces` iterates turn slices sequentially because three accumulators are shared across all slices: `subagentsById` (drained by `Agent`/`Task` tool_results, remainder → unattached trace), `sideCtx.initialPermissionModeSet` (capture-once for `agent_trace.session.initial_permission_mode`), and `slashTurns` (post-loop `attachSlashSubagents` nests subagents only when the session has exactly one slash-command turn — multi-triad sessions no-op to honor §2). All three are stamped onto every trace root at emission time. Parallelizing would silently break subagent pairing and initial-mode capture.

### 6. No zero-duration marker spans

- The prompt is a *property* of the turn (`agent_trace.prompt` attribute), not a sibling span.
- Waterfall renderers assume `durationMs > 0`. Honoring that keeps the UI honest.

### 7. Payload hygiene

- Tool inputs/outputs use a smaller cap (log-like content where losing rows is tolerable). Assistant text + reasoning use a larger cap (narrative content where the conclusion matters; thinking blocks routinely run 5–20 KB and a small cap would mangle them). Actual constants live in `lib/traces/traces.js`.
- `truncate(value, max)` accepts a per-call cap; callers pick the right constant.
- No `console.log` on the hot read path.

### 8. Server-side code lives outside the client bundle

- `ui/vite-plugin-transcript-api.ts` imports from `../lib/traces/store.js`. It runs in Node at dev / preview time, never in the browser.
- **Never import `lib/traces/*` from anything under `ui/src/`.** Those modules use `node:fs` — Vite will try to externalize and blow up.
- The plugin file lives at `ui/` root (sibling to `vite.config.ts`), not inside `ui/src/`, to make accidental browser imports harder.

## Non-goals (deliberately)

- **OTLP export or any external collector integration.** The transformer is pure, so a one-shot `transcript → OTLP JSONL` script is trivial if you ever need it. Don't reintroduce a live emitter.
- **Hook ingestion.** Hooks are fragile (undocumented `matcher` requirement, slash commands skip `UserPromptSubmit`, adapter bugs drop `agent_id`). Transcripts are complete and stable.
- **Live push.** 5s polling from the UI is enough.
- **Separate backend process.** Vite hosts the middleware. One process covers both dev and preview.
- **Harness-agnostic abstraction.** Current scope is Claude Code only.

## File layout

```
lib/traces/
  sessions.js                       listSessions — discover SessionFile[] on disk
  transcripts.js                    readTranscript — parse main + subagent JSONL
  traces.js                         pure transformer: transcript → Turn | UnattachedGroup
  store.js                          mtime+size cache + public query API
ui/
  vite.config.ts                    plugins: [react(), transcriptApi()]
  vite-plugin-transcript-api.ts     Node-only middleware for /api/traces
  src/                              React app (browser-only)
```

## UI principles (ui/src/)

- Pure view layer. The transformer is the only place data is shaped.
- ShadCN components as the primary building blocks; Tailwind for layout.
- **Reuse first.** Before building anything new, check if an existing ShadCN component (already installed in `ui/src/components/ui/`) maps to the use case. Prefer reusing it over hand-rolling — even if the fit is 80%, extend the existing component rather than introducing a parallel one.
- **Charts and visualizations default to ShadCN Charts** (Recharts under the hood, themed via `<ChartContainer>` / `<ChartTooltip>` / `<ChartLegend>`). Use the standard chart primitives (Area, Bar, Line, Pie, Radar, Radial) for any graph or data visualization. Only fall back to hand-rolled SVG/CSS when ShadCN Charts genuinely cannot express the visualization (e.g. bespoke waterfall layouts, span-tree renderings) — and document why in the component.
- Grouping transforms live colocated with the component that renders them (`groupConversations`, `collectTurns`, `flatten`). All pure.
- If the UI needs a new piece of information, add it to the transformer — don't recompute from span names.

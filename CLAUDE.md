# agent-profiler

A local trace viewer for Claude Code conversations. Reads session transcripts directly from disk and renders them as a span-tree waterfall. A React + Vite app with a small middleware plugin — no separate server process, no hooks, no OTEL SDK.

## North Star

**Claude Code's own per-session JSONL transcripts (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`) are the source of truth.** The viewer is a pure `(transcript → SpanNode tree → JSON)` pipeline. If the UI and the raw transcript disagree about what happened, the transcript is right.

## Core vocabulary — inference vs. tool call

These two are not the same thing. Confusing them is the largest recurring source of bugs in this transformer.

**Inference.** A single request to the remote Anthropic API. Something that costs money, takes wall-clock time, and ends with the model returning a response. Has a `requestId` — one per API round-trip. Every content block the model returned (thinking, text, tool_use) belongs to that inference and shares its `requestId`. Deduplicate: one span per distinct `requestId`.

**Tool call (`tool_use` content block).** Claude Code executing a local command — Bash, Read, Edit, Glob, Grep, etc. — on the user's machine. Produced *inside* an assistant response as a content block. The block carries a `requestId` because it was emitted by an inference, but the block itself is **not** an inference. Executing it is local, not remote. A single inference can emit zero, one, or many tool_use blocks; each one becomes its own tool span, separate from the inference span that generated it.

**In the transcript.**

- An `assistant` JSONL record carries `requestId`. The record's `message.content` is an array of content blocks (`text`, `thinking`, `tool_use`, …). Claude Code flushes each content block as its own JSONL row, so one API response ≈ N consecutive assistant records sharing one `requestId`.
- A `user` JSONL record whose `message.content` contains `tool_result` blocks is the *output* of one or more tool executions. It has no `requestId` of its own. The tool_result is paired to its `tool_use` via `tool_use_id`, not via `requestId`.

**What makes an assistant row an inference span.** An assistant JSONL row becomes an inference span **only when its content block is `thinking`** — the model's reasoning. A `text` content block does **not** produce an inference span; it produces a `gen_ai.assistant.message` event on the turn root, which the Conversation view renders as a chat bubble. A `tool_use`-only row produces neither; its tool span alone represents the round-trip. Rows sharing a `requestId` are **not merged** into a single span — each `thinking` row is its own inference span, representing a distinct streaming window.

**Why the asymmetry (reasoning → span, text → event).** Reasoning's primary signal is timing/cost (how long the model spent thinking, how many tokens) — the waterfall surfaces that as a bar. Text's primary signal is the content itself — the chat view surfaces that as a bubble. Emitting both a span and a chat event for `text` blocks caused UI duplication (the same content showed up twice: once as a waterfall bar, once as a bubble) without adding signal. Each kind now has exactly one UI surface.

**`thinking` still emits `gen_ai.assistant.reasoning` events when plaintext is present.** In real Claude Code transcripts, the plaintext is empty (encrypted in `signature`), so the event is dropped at emission by the empty-content filter. The emission path is retained for harnesses or future transcript versions that may surface plaintext reasoning.

**Consequence for the transformer.** Inference spans are per-thinking-row. Tool spans are per-`tool_use` block, with duration `tool_result.ts − tool_use.ts`. A `[thinking, tool_use]` response with one `requestId` emits one inference span (thinking) + one tool span (tool_use). A `[text]`-only response emits one `gen_ai.assistant.message` event on the turn root and no inference span. A `[text, tool_use]` response emits one message event + one tool span — no waterfall bar for the text's streaming window, by design.

**Token aggregation** still dedupes by `requestId` (identical `usage` blob appears on every row of one response). Turn-level totals are unaffected by the span emission rule.

**`agent_trace.inference.prompt` semantics.** Populated by walking backward from the assistant row through non-assistant records until the first prior assistant row. Present on the first qualifying block of a response; **absent** (key omitted, not empty string) on continuation blocks. Applies only to reasoning spans (text blocks have no span to attach a prompt to).

**Anti-patterns (do not ship):**

- Emitting an inference span per `tool_use` content block (conflates inferences with tool calls).
- Emitting an inference span for a `text` content block — text flows through `gen_ai.assistant.message` events only; a span would duplicate the chat bubble.
- Merging `thinking` + `text` rows of one `requestId` into a single span.
- Double-counting `usage` tokens by summing across every assistant row (use `requestId` dedupe for aggregates).
- Counting inference spans in `turn.toolCount` (they are structural, not user-facing work).
- Labeling inference spans with `tool_use` (even though that is a legitimate `stop_reason` value, it reads as a tool classification).

## Design principles

### 0. Simplicity over completeness. Prioritize the waterfall UI above all.

### 1. The transformer is pure and deterministic

- `lib/traces/traces.js#toTraces(sessionId, bundle)` takes parsed records and returns `TraceSummary[]` — one trace per turn, plus an optional `unattached` trace when Skill-dispatched subagents have no paired tool_use. No I/O. No time-of-day dependence. Same input → same output.
- All shaping (turn slicing, subagent pairing, token aggregation, attribute naming) lives here.
- The Vite middleware (`ui/vite-plugin-transcript-api.ts`) and the reader (`lib/traces/transcripts.js`) do nothing but I/O. The transformer does nothing but transform.

### 2. Deterministic subagent pairing

**Ingestion rule — absolute, no exceptions.** **Never make ingestion, pairing, routing, grouping, or identity decisions based on transcript timestamps.** Timestamps describe flush order, not causal order; in slash-command sessions they're written at end-of-command with identical-millisecond values, while the subagents they dispatched ran minutes earlier. Containment checks, nearest-neighbor, and precedence ordering by timestamp are all traps — they *look* structural and silently produce wrong answers. Treat timestamps as display-only. Pair via structural links (`parentUuid` chain, `toolUseResult.agentId`, `promptId`, `sessionId`, on-disk filename layout) — if no structural link exists, admit defeat and emit the subagent as `kind: 'unattached'`.

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

One trace per turn — OTel-conventional. Session is an attribute (`session.id`) on each trace root, not a wrapping span. Conversations are a UI-side grouping of traces sharing a session id.

```
Trace { kind: 'turn', traceId: <sid>:turn:N }
  turn:N                             attrs: session.id, agent_trace.harness, agent_trace.prompt,
                                            gen_ai.request.model, per-turn token counts
    <ToolName>                       duration = tool_result.ts − tool_use.ts
    Agent                            subagent-spawning tool
      subagent:<agentType>           nested subagent subtree
        <nested tool spans …>

Trace { kind: 'turn', traceId: <sid>:turn:N }   ← slash-command turn (case A)
  turn:N        prompt = "/cmd args"            collapsed from caveat → /cmd → stdout triad
    Skill       synthetic; attrs: agent_trace.tool.slash_command, agent_trace.tool.name='Skill'
      subagent:<agentType>           attached only when session has exactly one slash triad

Trace { kind: 'unattached', traceId: <sid>:unattached }   ← only when orphans exist
  subagents:unattached
    subagent:<agentType>             Skill-dispatched or otherwise unlinked
                                      (also: multi-triad sessions with no structural link)
```

Pre-first-turn hooks (e.g. `hook:SessionStart`) with `durationMs > 0` relocate onto turn 1's root. Zero-duration hooks remain events (Principle 6). If a file has pre-turn content but zero turns, that content is dropped.

`traceId` is deterministic: `${sessionId}:turn:${n}` or `${sessionId}:unattached`. React keys stay stable across polls.

Attribute names: `session.id` (OTel semconv) + `agent_trace.prompt`, `agent_trace.tool.name`, `agent_trace.tool.input_summary`, `agent_trace.tool.output_summary`, `agent_trace.subagent.type`, `agent_trace.subagent.task`, `gen_ai.request.model`, plus per-turn `agent_trace.turn.{input,output,cache_read,cache_creation}_tokens`.

Assistant output is captured as events on the turn root (or on `subagent:<type>` spans for subagent records), not as spans. Two event names follow OTel GenAI semconv:

- `gen_ai.assistant.message` with `gen_ai.message.content` — visible text replies.
- `gen_ai.assistant.reasoning` with `gen_ai.reasoning.content` — extended-thinking reasoning.

Records with no timestamp and empty/whitespace content are dropped. Events on the turn root are stable-sorted by `timeMs` so readers see chronological order.

### 5a. Cross-slice invariants (do not parallelize)

`toTraces` iterates turn slices sequentially. Three pieces of state are shared across all slices:

1. `subagentsById: Map` — consumed as `Agent`/`Task` tool_results pair to subagent files. Remainder becomes the unattached trace.
2. `sideCtx.initialPermissionModeSet` — ensures `agent_trace.session.initial_permission_mode` is captured exactly once across the whole transcript.
3. `slashTurns` registry — accumulated as slash-command slices emit synthetic `Skill` spans. The post-loop `attachSlashSubagents` pass reads this to nest unpaired subagents, but ONLY when the session has exactly one slash-command turn (1-to-1 by construction). Multi-triad sessions no-op to honor the no-timestamps rule (§2).

All three are stamped onto every trace root at emission time. The slice loop must stay sequential; parallelizing would silently break subagent pairing and initial-mode capture.

### 6. No zero-duration marker spans

- The prompt is a *property* of the turn (`agent_trace.prompt` attribute), not a sibling span.
- Waterfall renderers assume `durationMs > 0`. Honoring that keeps the UI honest.

### 7. Attribute naming: follow OTEL GenAI semantic conventions where they exist

- `gen_ai.request.model` for the assistant model.
- Plugin-specific metadata lives under `agent_trace.*`.
- Don't invent names that overlap with official semconv.

### 8. Payload hygiene

- Truncate tool inputs/outputs at `SUMMARY_MAX` (4000 chars) — log-like content where losing rows is tolerable.
- Truncate assistant text + reasoning at `ASSISTANT_MAX` (16000 chars) — narrative content where the conclusion matters. Thinking blocks routinely run 5–20 KB; a 4 KB cap would mangle them.
- `truncate(value, max)` accepts a per-call cap; callers pick the right constant.
- No `console.log` on the hot read path.

### 9. Server-side code lives outside the client bundle

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
- Grouping transforms live colocated with the component that renders them (`groupConversations`, `collectTurns`, `flatten`). All pure.
- If the UI needs a new piece of information, add it to the transformer — don't recompute from span names.

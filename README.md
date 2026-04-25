# agent-trace

A local trace viewer for Claude Code conversations. Reads your session transcripts from `~/.claude/projects/*/` and renders them as a waterfall UI at <http://localhost:5173/> — session → turn → tool call → subagent, with prompts, tool I/O, and per-turn token usage inline.

No hooks, no background collector, no separate server process. A Vite app with a 20-line middleware plugin that reads transcripts on demand.

## What it does

- Discovers every Claude Code session transcript on your machine (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`).
- Reads paired subagent transcripts (`<sessionId>/subagents/agent-<agentId>.jsonl`) and nests them under the tool call that spawned them.
- Renders a trace waterfall with tool durations, prompts, per-turn token totals, and span-level detail.
- Polls every 5 seconds — live sessions update as Claude Code writes new messages to disk.

## Install

```bash
/plugin install agent-trace@devon-plugins
```

The first run needs `npm install` inside `ui/` (see below).

## Usage

### Dev (with HMR)

```bash
cd plugins/agent-trace/ui
npm install  # first time only
npm run dev
```

Open `http://localhost:5173/`.

### Local "prod" (static build)

```bash
cd plugins/agent-trace/ui
npm run build
npm run preview
```

Open `http://localhost:5173/`. Same URL, but serving the compiled bundle from `ui/dist/` and the same transcript-reading middleware.

### Slash command

`/agent-trace:explore` — opens `http://localhost:5173/` if the dev or preview server is up; otherwise tells you how to start it.

## Architecture

```
~/.claude/projects/<project-slug>/
    <sessionId>.jsonl                ◄── main conversation transcript
    <sessionId>/subagents/
      agent-<agentId>.jsonl          ◄── subagent sidechain
      agent-<agentId>.meta.json
                │
                ▼
┌───────────────────────────────────────┐
│     Vite (dev or preview) process     │
│                                       │
│   /api/traces middleware ──►          │
│     getAllTraces()                    │
│        │                              │
│        ▼                              │
│   lib/traces/store.js                 │
│   (mtime+size keyed cache)            │
│        │                              │
│        ▼                              │
│   lib/traces/traces.js                │
│   (pure transformer)                  │
│        │                              │
│        ▼                              │
│   React UI at /                       │
└───────────────────────────────────────┘
```

Stateless and deterministic. Restart any time.

## Trace topology

One trace per turn (OTel-conventional); session is an attribute (`session.id`)
on each trace root. Conversation is a UI-side grouping of traces sharing a
session id.

```
Trace { kind: 'turn', traceId: <sid>:turn:N }
  turn:N                     ← root; attrs: session.id, gen_ai.request.model, agent_trace.prompt, …
    <ToolName>               ← tool_use + tool_result → duration
    Agent                    ← subagent-spawning tool
      subagent:<type>        ← nested subagent tree (linked via toolUseResult.agentId)
        <tools …>

Trace { kind: 'unattached', traceId: <sid>:unattached }   ← only when orphans exist
  subagents:unattached
    subagent:<type>          ← Skill-dispatched or otherwise unlinked
```

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_TRACE_LIMIT` | `200` | Cap on how many most-recent sessions the `/api/traces` middleware returns |

## Verifying it works

1. `cd ui && npm run dev` — Vite prints `http://localhost:5173/`.
2. `curl -s http://localhost:5173/api/traces | jq '.traces | length'` — returns the count.
3. Open the UI; the most recent sessions appear in the sidebar with the first user prompt as each conversation's label.
4. Click a session that used subagents (e.g. anything invoked via `Task`/`Agent` or a `/<skill>` slash command) — confirm the waterfall nests tools under the subagent span.

## Token attribution

Every turn root and every `subagent:<type>` span carries token aggregates deduped by `requestId` — a single API response emits multiple JSONL rows with identical `usage`, and summing per row inflates totals 2-3×. We sum each distinct request exactly once.

| Granularity | Captured directly | How |
| --- | --- | --- |
| Per turn | input / output / cache_read / cache_creation / context / request_count | `agent_trace.turn.*_tokens`, `agent_trace.turn.request_count` |
| Per subagent | input / output / cache_read / cache_creation / request_count | `agent_trace.subagent.*_tokens`, `agent_trace.subagent.request_count` |
| Per API request | — (deferred) | Would be one entry per `requestId`. Add when a UI consumer needs it. |
| Per tool call (Read, Bash, WebFetch, …) | — (not directly recoverable) | Cost shows up inside the *next* request's `cache_creation_input_tokens` as a lump. Requires tokenizing the `tool_result.content` body. |
| Per skill invocation | — (not directly recoverable) | Same mechanism as per-tool — skill body is injected content folded into the next request's cache_creation. |
| Per user prompt | — (not directly recoverable) | Same. |
| Per `isMeta` harness injection | — (not directly recoverable) | Same. |
| Cache-TTL split (`ephemeral_5m` vs `ephemeral_1h`) | — (deferred) | Present in raw `usage.cache_creation.*`. Add when a UI consumer needs it. |
| Server-tool-use counts (`web_search`, `web_fetch`) | — (deferred) | Present in raw `usage.server_tool_use.*`. Add when a UI consumer needs it. |

"Not directly recoverable" items would require tokenizing transcript content (local tokenizer or Anthropic's `count_tokens` API); none of that is wired in.

## Things that aren't captured

- Anything you haven't conversed about in Claude Code. Transcripts are the only input.
- Server-side timings that aren't in the transcript (exact network latency, rate-limit delays). Tool durations are wall-clock between `tool_use` and `tool_result` timestamps.

## Things that aren't built

- OTLP export or any external collector integration. The transformer is pure, so a one-shot `transcript → OTLP JSONL` script is ~30 lines if you ever need it, but nothing like that is wired in.
- Live push (hooks, websockets). The 5s poll is intentional.
- Cross-session comparison views, alerting, remote collectors.

## TODO

### General

- [ ] Switch between token view and trace view
- [ ] Attachment handling?
- [ ] Update session preview sidebar to pick better label
- [ ] Project Icons
- [ ] Production-ize
- [ ] Harness agnostic?

### Trace view

- [ ] Collapse/expand prompts/messages in trace view
- [ ] Style

### Token view

- [ ] Better icons for token view
- [ ] Graph for token accumulation in token view
- [ ] Turn separator

### Marketing

- [ ] Blog post about how long Anthropic took to debug Claude Code deficiencies.

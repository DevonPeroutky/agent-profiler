# agent-profiler

A local trace viewer for [Claude Code](https://claude.com/claude-code) conversations. Reads your session transcripts from `~/.claude/projects/*/` and renders them as a span-tree waterfall — session → turn → tool call → subagent, with prompts, tool I/O, and per-turn token usage inline.

No hooks. No background collector. No telemetry. Just a small Node server that reads your transcripts on demand.

## Install & run

One command, zero config:

```bash
npx agent-profiler
```

Opens `http://localhost:5173/` in your browser. Requires **Node 18+**. The first run downloads the package (~few MB); subsequent runs use the npx cache.

To install globally instead:

```bash
npm install -g agent-profiler
agent-profiler
```

## Usage

```
agent-profiler [options]

  -p, --port <n>     Port to listen on (0 = pick a free one). Default 5173
      --no-open      Do not open a browser tab
  -v, --verbose      Log every HTTP request to stderr
  -V, --version      Print version and exit
  -h, --help         Show this message
```

Examples:

```bash
agent-profiler --port 7777          # custom port
agent-profiler --no-open            # don't open browser (e.g. on a server)
agent-profiler --verbose            # log requests for debugging
```

## Endpoints

The server is a static file host plus three JSON endpoints. You can `curl` them directly.

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Single-page UI |
| `POST /api/traces` | Trace tree for every recent session under `~/.claude/projects/` |
| `GET /api/transcript?sessionId=…` | Raw JSONL bundle for one session (used by the Debug tab) |
| `GET /api/health` | `{ ok, version, sessionCount, uptimeSeconds }` for monitoring |

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_TRACE_PORT` | `5173` | Default port (overridden by `--port`) |
| `AGENT_TRACE_LIMIT` | `200` | Cap on most-recent sessions returned by `/api/traces` |
| `AGENT_PROFILER_NO_UPDATE_CHECK` | _unset_ | Disable the daily "new version available" notice |

## What it does

- Discovers every Claude Code session transcript on your machine (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`).
- Reads paired subagent transcripts (`<sessionId>/subagents/agent-<agentId>.jsonl`) and nests them under the tool call that spawned them.
- Renders a trace waterfall with tool durations, prompts, per-turn token totals, and span-level detail.
- Polls every 5 seconds — live sessions update as Claude Code writes new messages to disk.

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
│  agent-profiler (Node http server)    │
│                                       │
│   /api/traces ──►                     │
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

One trace per turn (OTel-conventional); session is an attribute (`session.id`) on each trace root. Conversation is a UI-side grouping of traces sharing a session id.

```
Trace { kind: 'turn', traceId: <sid>:turn:N }
  turn:N                     ← root; attrs: session.id, gen_ai.request.model, agent_trace.prompt, …
    inference                ← one per requestId; carries tokens, stop_reason, content events
      <ToolName>             ← tool_use + tool_result → duration
      Agent                  ← subagent-spawning tool
        subagent:<type>      ← nested subagent tree (linked via toolUseResult.agentId)
          <tools …>

Trace { kind: 'unattached', traceId: <sid>:unattached }   ← only when orphans exist
  subagents:unattached
    subagent:<type>          ← Skill-dispatched or otherwise unlinked
```

## Verifying it works

```bash
agent-profiler --port 7777 --no-open &
curl -s http://localhost:7777/api/health | jq
curl -s -X POST http://localhost:7777/api/traces | jq '.traces | length'
```

You should see a session count from `/api/health` and a non-zero trace count from `/api/traces` if you've used Claude Code recently.

## Token attribution

Every turn root and every `subagent:<type>` span carries token aggregates deduped by `requestId` — a single API response emits multiple JSONL rows with identical `usage`, and summing per row inflates totals 2-3×. We sum each distinct request exactly once.

| Granularity | Captured directly |
| --- | --- |
| Per turn | input / output / cache_read / cache_creation / context / request_count |
| Per subagent | input / output / cache_read / cache_creation / request_count |
| Per API request | deferred (one entry per `requestId`; add when a UI consumer needs it) |
| Per tool call | not directly recoverable — cost lands inside the *next* request's `cache_creation_input_tokens` |
| Per skill / user prompt | not directly recoverable — same mechanism as per-tool |

## Things that aren't captured

- Anything you haven't conversed about in Claude Code. Transcripts are the only input.
- Server-side timings that aren't in the transcript (exact network latency, rate-limit delays). Tool durations are wall-clock between `tool_use` and `tool_result` timestamps.

## Things that aren't built

- OTLP export or any external collector integration. The transformer is pure, so a one-shot `transcript → OTLP JSONL` script is ~30 lines if you ever need it.
- Live push (hooks, websockets). The 5s poll is intentional.
- Cross-session comparison views, alerting, remote collectors.

## Develop

```bash
git clone https://github.com/devonperoutky/agent-profiler
cd agent-profiler
npm install
npm run dev          # vite + HMR at http://localhost:5173/
npm run build        # builds ui/dist/
npm run test         # node:test unit + smoke tests
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
```

The dev server runs the same `/api/traces` middleware as production via `ui/vite-plugin-transcript-api.ts`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

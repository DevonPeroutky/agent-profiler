# agent-profiler

A local trace viewer for [Claude Code](https://claude.com/claude-code) conversations. Reads your session transcripts from `~/.claude/projects/*/` and renders them as a span-tree waterfall — session → turn → tool call → subagent, with prompts, tool I/O, and per-turn token usage inline.

No hooks. No background collector. No telemetry. Just a small Node server that reads your transcripts on demand.

## Why

If you use Claude Code daily, you have a goldmine of session transcripts sitting on disk that you can't easily look at. agent-profiler turns them into a waterfall you can actually read:

- **See where time and tokens went.** Per-turn token totals, per-tool durations, per-subagent breakdowns.
- **Inspect what really happened.** Prompts, tool inputs/outputs, subagent transcripts — all inline.
- **Live updates.** Polls every 5 seconds, so an in-flight session keeps filling in as Claude Code writes new messages.
- **Zero setup.** No SDK, no hook config, no collector. If you've used Claude Code, the data is already there.

## Requirements

- **Node 18+**
- An existing `~/.claude/projects/` directory (created automatically the first time you use Claude Code)

## Install & run

One command, zero config:

```bash
npx agent-profiler
```

Opens `http://localhost:5173/` in your browser. The first run downloads the package (~few MB); subsequent runs use the npx cache.

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

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_TRACE_PORT` | `5173` | Default port (overridden by `--port`) |
| `AGENT_TRACE_LIMIT` | `200` | Cap on most-recent sessions returned by `/api/traces` |
| `AGENT_PROFILER_NO_UPDATE_CHECK` | _unset_ | Disable the daily "new version available" notice |

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

For internals — the read pipeline, trace topology, token attribution, and what's deliberately out of scope — see [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

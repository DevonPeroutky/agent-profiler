# Contributing

Thanks for working on agent-profiler.

## Local setup

```shell
npm install
npm run dev
```

Before opening a change, run the checks that match the files you touched:

```shell
npm run test
npm run typecheck
npm run lint
```

## Project shape

- Server-side trace ingestion lives in `lib/traces/`.
- The production CLI lives in `bin/agent-profiler.js`.
- The React UI lives in `ui/src/`.
- The Vite dev middleware lives in `ui/vite-plugin-transcript-api.ts`.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) before changing trace parsing, pairing, token attribution, or cache behavior.

## Contribution notes

- Keep agent-profiler local-only. Do not add telemetry, hosted collectors, or network export paths without an explicit design discussion.
- Preserve deterministic parsing. Transcript bytes should be the source of truth.
- Prefer focused changes with tests over broad refactors.
- Update docs when changing CLI behavior, supported harnesses, or adapter contracts.

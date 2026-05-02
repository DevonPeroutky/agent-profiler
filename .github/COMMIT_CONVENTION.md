# Commit message convention

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)** so that [release-please](https://github.com/googleapis/release-please) can decide the next version number and auto-generate the CHANGELOG when it opens release PRs.

## Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Types that affect the version

| Type | Effect on version | Use when |
| --- | --- | --- |
| `fix:` | patch bump (`0.1.0` → `0.1.1`) | Bug fix the user can observe |
| `feat:` | minor bump (`0.1.0` → `0.2.0`) | New behaviour the user can opt into |
| `feat!:` or `fix!:` (or any type with `!`) | major bump (`0.1.0` → `1.0.0`) | Breaking change |

A `BREAKING CHANGE:` footer in the body has the same effect as `!`.

## Types that don't bump

These show up in the CHANGELOG under "Other" if you list them — most people skip them. They don't trigger a release on their own:

- `chore:` — repo housekeeping (deps, lint config, CI tweaks)
- `docs:` — README, comments, JSDoc
- `refactor:` — internal-only restructuring with no user-visible change
- `test:` — test additions or fixes
- `build:` — build system changes
- `ci:` — CI changes
- `perf:` — performance improvement
- `style:` — formatting only

## Scopes used here

Optional. Suggested values:

- `cli` — `bin/agent-profiler.js`
- `transformer` — `lib/traces/*` (the pure transcript → trace pipeline)
- `ui` — anything under `ui/src/`
- `api` — `/api/traces`, `/api/transcript`, `/api/health` shapes

## Examples

```
feat(cli): add --json output for /api/traces

fix(transformer): dedupe inferences by requestId across API errors

feat!: replace AGENT_TRACE_LIMIT default of 200 with 50

  BREAKING CHANGE: the default cap on returned sessions changed from
  200 to 50 to keep first-paint snappy. Set AGENT_TRACE_LIMIT=200 to
  restore the old behaviour.

chore: bump biome to 1.10
```

## Why?

`release-please` reads the commit log on `main`, decides whether the next
version is a patch / minor / major, opens a "chore(release): vX.Y.Z" PR
with a populated CHANGELOG, and waits for you to merge. Merging that PR
tags the release and triggers `npm publish --provenance`.

# Plan: Use `parentUuid` for turn slicing and inference prompts

## Context

The transformer currently slices turns by walking JSONL records linearly and starting a new turn at every non-meta user prompt (`sliceTurns` in `lib/traces/traces.js:1062`). The slash-command triad (caveat → `/cmd` → stdout) is detected as a special case via `detectSlashTriad` (`:1010`), which is the only place `parentUuid` is consulted.

This works in practice but has two problems:

1. **A user prompt mid-stream splits an in-flight `requestId`.** If the user submits a new prompt while the model is still flushing rows of the prior response, the linear scan starts a new turn between two rows that share a `requestId`. The new per-`requestId` inference emitter then produces two inference spans for one API round-trip, one in each turn. Slice-local `dedupeUsagesByRequestId` does the same, so token aggregates also drift.
2. **`detectSlashTriad` is a parallel turn-slicing rule** that exists only because the linear scan can't naturally collapse three user records into one turn. It's 39 lines of special-case logic for a structural relationship that `parentUuid` already encodes.

The harness is already telling us the correct answer via `parentUuid`: every conversational record points back at its predecessor, and chasing the chain upward to the topmost user-prompt record gives you the turn root unambiguously. This plan replaces the linear scan with a chain walk and folds slash detection into it.

A second, smaller change: `agent_trace.inference.prompt` is computed today by walking JSONL position backward from the canonical row (`buildInferenceSpansForSlice`). With a `parentUuid` index already built for turn slicing, the prompt walk becomes a five-line chain traversal — structurally honest and cheaper.

## Goals

1. Slice turns by `parentUuid`-rooted ancestry, not by JSONL position. A turn is the set of records that descend, via `parentUuid`, from a user-prompt record.
2. Delete `detectSlashTriad`. Slash triads collapse for free because the invocation and stdout records' `parentUuid` chains lead back to the caveat — same turn root, same slice.
3. Anchor `agent_trace.inference.prompt` derivation in the chain, not in JSONL position.
4. No defensive guards, no migration shims, no behavioral changes for the UI. Token aggregates, inference counts, span tree shape, and chat surface all stay identical for well-formed transcripts.

## Non-goals

- Changing the `kind: 'slash'` slice variant or how the synthetic `Skill` span is emitted. Those still happen; they just get triggered from the new chain rule instead of from `detectSlashTriad`.
- Subagent pairing, hook attachment, tool-span reparenting. Unaffected.
- Touching the UI.

## Design

### Turn root determination

Define one helper:

```js
// Returns the topmost user-prompt record in the parentUuid chain for `rec`,
// or null if the chain doesn't bottom out at one. A user-prompt record is a
// `user` record whose message.content is a string (NOT a tool_result-only
// record). For slash triads, the caveat — the topmost user record in the
// triad — is the turn root; the invocation and stdout descend from it.
function findTurnRoot(rec, byUuid) {
  let cur = rec;
  let lastPrompt = null;
  while (cur) {
    if (isUserPromptRecord(cur)) lastPrompt = cur;
    if (!cur.parentUuid) break;
    cur = byUuid.get(cur.parentUuid);
  }
  return lastPrompt;
}

function isUserPromptRecord(rec) {
  if (rec?.type !== 'user') return false;
  return typeof rec?.message?.content === 'string';
}
```

### New `sliceTurns`

```js
function sliceTurns(records) {
  const byUuid = new Map();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);

  // Group records by their turn root. Order of turns is the JSONL order in
  // which their roots first appear.
  const groupsByRoot = new Map(); // rootUuid → number[]
  const rootOrder = [];           // rootUuid in first-seen order

  for (let i = 0; i < records.length; i++) {
    const root = findTurnRoot(records[i], byUuid);
    if (!root) continue; // sidecar metadata (custom-title, file-history-snapshot, ...)
    const key = root.uuid;
    let bucket = groupsByRoot.get(key);
    if (!bucket) {
      bucket = [];
      groupsByRoot.set(key, bucket);
      rootOrder.push(key);
    }
    bucket.push(i);
  }

  // Each group → one TurnSlice. startIdx/endIdx are min/max of the bucket
  // indices so existing slice-clamped consumers (buildInferenceSpansForSlice,
  // dedupeUsagesByRequestId, prompt walk) continue to work unchanged.
  const slices = [];
  for (const rootUuid of rootOrder) {
    const idxs = groupsByRoot.get(rootUuid);
    const startIdx = idxs[0];
    const endIdx = idxs[idxs.length - 1];
    const root = byUuid.get(rootUuid);
    const isMeta = Boolean(root.isMeta);
    const promptText = String(root.message?.content ?? '');

    // Slash detection becomes a property of the slice, not a separate scan.
    // A turn is `kind: 'slash'` iff its root is a caveat record and the
    // chain contains an invocation child whose content starts with `/`.
    const slashMeta = detectSlashFromChain(rootUuid, idxs, records);
    if (slashMeta) {
      slices.push({ kind: 'slash', startIdx, endIdx, prompt: slashMeta.commandLine, isMeta: false, slashMeta });
    } else {
      slices.push({ kind: 'turn', startIdx, endIdx, prompt: promptText, isMeta });
    }
  }
  return slices;
}
```

`detectSlashFromChain` is a tiny replacement for `detectSlashTriad` that just checks "is the root a caveat-tagged user record, and does the bucket contain an invocation child of it?" — three lines, no `parentUuid` re-walking, because the bucket is already the chain.

### Inference prompt walk via chain

In `buildInferenceSpansForSlice`, replace the index-walk that builds `agent_trace.inference.prompt`:

```js
// Today: walks records[firstIdx-1 .. startIdx] backward over non-assistant
// records until the prior assistant row.
//
// Proposed: walk parentUuid from the canonical record upward, accumulating
// any user / tool_result / attachment record content, until the chain hits
// a different-requestId assistant row OR the slice's startIdx (whichever
// comes first).
function walkPromptChain(canonical, byUuid, sliceStartIdx, indexByUuid) {
  const out = [];
  let cur = byUuid.get(canonical.parentUuid);
  while (cur) {
    const idx = indexByUuid.get(cur.uuid);
    if (typeof idx === 'number' && idx < sliceStartIdx) break;
    if (cur.type === 'assistant') {
      if (cur.requestId !== canonical.requestId) break;
      // Same requestId — multi-row response prefix; skip and keep walking.
    } else {
      out.unshift(cur);
    }
    if (!cur.parentUuid) break;
    cur = byUuid.get(cur.parentUuid);
  }
  return out.map(triggerPromptText).filter(Boolean).join('\n\n');
}
```

The `byUuid` map and `indexByUuid` map are already built in `sliceTurns`; thread them through to `buildInferenceSpansForSlice` (or rebuild them locally — they're cheap).

### What goes away

- `detectSlashTriad` (`traces.js:1010–1048`) — deleted. Slash detection is one helper call inside the new `sliceTurns`.
- The "find a non-meta user prompt at boundary" linear walk in the old `sliceTurns` — replaced by the chain walk.
- The index-based prompt walk in `buildInferenceSpansForSlice` — replaced by the chain walk.

### What stays

- The `TurnSlice` type (`{ kind, startIdx, endIdx, prompt, isMeta, slashMeta? }`). New `sliceTurns` returns the same shape; downstream consumers don't change.
- `dedupeUsagesByRequestId`, the inference emitter's `requestId` grouping, the tool-span reparenting via `tool_use_id` map, hook attachment via `tool_use_id`, subagent pairing via `toolUseResult.agentId`. All unchanged.
- The `kind: 'slash'` slice path and the `buildSlashSkillSpan` synthesis. Same code, triggered from the new slice rule.

## Implementation steps

1. Add `findTurnRoot` and `isUserPromptRecord` helpers near `sliceTurns` in `lib/traces/traces.js`.
2. Replace the body of `sliceTurns` with the chain-grouping implementation. Build `byUuid` once at the top.
3. Replace `detectSlashTriad` with `detectSlashFromChain` (small helper that reads the bucket the new slicer already built). Delete the old function.
4. Pass `byUuid` (or build it locally) into `buildInferenceSpansForSlice` and replace the index-based prompt walk with the chain walk.
5. Run the existing parity script across all sessions: per-turn `inference` direct-children count must equal `request_count`, token aggregates must be unchanged.

## Verification

1. **Token-aggregate parity**: across every saved session, per-turn `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens` are bit-for-bit identical to pre-PR.
2. **Inference-count parity**: `inference` direct-children of every turn root equals `agent_trace.turn.request_count`. Same for subagents.
3. **Slash-triad regression**: open a session containing `/clear` or `/compact`. The `kind: 'slash'` slice still emits, the synthetic `Skill` span still appears, and the turn's prompt text still parses correctly.
4. **Manual UI smoke**: open session `80a43f04-…`. Overview "9 inferences" still matches the chart footers. Chat surface unchanged.
5. **Mid-stream interrupt** (synthetic): if any saved fixture has a `requestId` that today straddles a turn boundary, the new slicer should put all rows of that `requestId` in the same turn and emit one inference span. Validate by running the parity script and confirming no turn boundary falls between two rows of the same `requestId`.

## Files touched

- `lib/traces/traces.js` — `sliceTurns` rewrite, `detectSlashTriad` deleted, `buildInferenceSpansForSlice` prompt walk replaced.
- `CLAUDE.md` — §2 already lists `parentUuid` as a structural link; update the slash-detection paragraph to note that the triad collapse is now a natural consequence of chain-rooted slicing rather than a separate detection pass.

That's the whole plan. Roughly +60 / -90 lines net; transformer gets shorter.

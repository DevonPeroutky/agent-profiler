# Plan: Unify "inference" as one concept in state (backend only)

## Problem overview

The agent-profiler codebase uses the word "inference" with two different meanings, and the inconsistency surfaces in the UI as numerically contradictory metrics. On session `80a43f04-8b60-4951-9714-b9f57393748f` turn 2, the Overview tile reads "9 inferences" while both chart footers read "2 inferences." Both numbers are internally correct; they are measuring different things, with the same word.

The user-facing meaning of "inference" is **a remote round-trip to the Anthropic API**. That is the unit that costs money and wall-clock time and corresponds 1:1 with what a user means when they ask "how many times did Claude Code call the model in this turn?" Whether the model returned `thinking`, `text`, `tool_use`, or any combination is a *content* property of the round-trip, not a different kind of thing.

Crucially, **tool calls are not inferences**. A `tool_use` content block is local execution — the agent harness runs the command, captures the output, and feeds it back into the *next* inference as added context. Local execution is not an API round-trip and must not be counted as one.

This plan is **backend only**. It restructures the transformer (`lib/traces/traces.js`) and updates `CLAUDE.md` so that the state layer mirrors the API-round-trip reality. UI changes are deferred to a follow-up plan.

## Goals

1. **Every API round-trip is represented by exactly one `inference` span in state** — one per distinct `requestId` within a slice.
2. **All "inference count" surfaces converge on a single source of truth** — `inferences.length` per turn — equal by construction to `agent_trace.turn.request_count`.
3. **Tool calls remain tool spans** with no inference-level claim of their own. Each tool span is the child of the inference that emitted its `tool_use` block, so the relationship "this tool call belongs to that inference" is structural.
4. **Each inference span carries the information needed to render any UI surface**, gated on attributes the inference carries (block-presence flags) and OTel-semconv events on the span.
5. **Nothing is double-counted.** Token aggregates and inference counts derive from the same record set with the same exclusion filters, locked behind a single shared predicate.

## Non-goals (this plan)

- **All UI changes.** The transformer change is content-additive: existing UI surfaces continue to work because (a) they consume `inference` spans by `name`, and (b) the OTel-semconv events they read (`gen_ai.assistant.message`, `gen_ai.assistant.reasoning`) keep their names and schemas — only their *parent span* changes. Migrating UI surfaces to read the new `has_*` flags, drop the `'assistant-message'` step kind, etc., is a separate plan.
- **Renaming the span.** `name: 'inference'` matches the canonical CLAUDE.md vocabulary.
- **Renaming UI labels.** State is correct; rendering decisions stay where they are.
- **Touching tool spans, subagent pairing, slash-command handling, hooks, or context attachments** beyond re-parenting tool spans under their emitting inference (see Reparenting below). Pairing logic (CLAUDE.md §2) and cross-slice invariants (§5a) are unchanged.

## Background

### The two definitions in active use today

- **Definition A — "API round-trip"** (one per `requestId`). The cost/billing unit.
- **Definition B — "Reasoning round-trip"** (one per `thinking`-content row). The narrower rule the current emitter uses.

The plan makes **Definition A canonical at the state layer**. Definition B becomes a UI rendering filter ("draw the reasoning bubble for inferences whose `has_thinking` is true"), not a state shape. UI follow-up will adopt that filter.

### Where each definition lives today

| Surface | File | Definition |
|---|---|---|
| `agent_trace.turn.request_count` | `lib/traces/traces.js:1523`, derived via `dedupeUsagesByRequestId` (`:441–457`) | A |
| Token aggregates (input/output/cacheRead/cacheCreation) | `lib/traces/traces.js`, deduped by `requestId` | A |
| `name: 'inference'` spans in the tree | `lib/traces/traces.js:513–597` (`buildInferenceSpans`) | B |
| `gen_ai.assistant.message` events on turn root / subagent root | `lib/traces/traces.js`, `extractAssistantEvents` | text content routes here instead of becoming spans |

After this plan, the only thing in column "Definition" is "A" — across every backend-emitted artifact.

### Why the current split exists (CLAUDE.md "emission rule")

CLAUDE.md previously said only `thinking` rows produce an `inference` span; `text` rows produce events on the turn root; `tool_use`-only rows produce neither. The justification was a UI rendering policy ("each content kind gets one rendering surface").

That UI policy is correct. Hardening it into a state-shape rule is what causes the count drift. The CLAUDE.md update accompanying this plan moves the policy from "transformer pre-decides which surface gets what" to "transformer emits a content-kind-agnostic inference; UI applies the rendering policy."

### Feasibility check (raw JSONL)

Inspection of `~/.claude/projects/.../80a43f04-….jsonl` confirms every assistant row — `thinking`, `text`-only, `tool_use`-only — carries the same identity/timing/usage fields:

| Field | Source | thinking | text-only | tool_use-only |
|---|---|---|---|---|
| `requestId` | `rec.requestId` | ✓ | ✓ | ✓ |
| `timestamp` | `rec.timestamp` | ✓ | ✓ | ✓ |
| `message.id` | record | ✓ | ✓ | ✓ |
| `message.model` | record | ✓ | ✓ | ✓ |
| `message.stop_reason` | record (terminal block of the response) | ✓ | ✓ | ✓ |
| `message.usage.{input,output,cache_read,cache_creation}` | record | ✓ | ✓ | ✓ |

Unification is structurally feasible with no new ingestion work.

## Design: one inference span per `requestId`

### Emission rule

**One `inference` span per distinct `requestId` within a slice (turn or subagent).** Replaces the current per-`thinking`-row emission.

Per-`requestId` (not per-row) is chosen for three reasons:

1. It is exactly Definition A. `inferences.length` per slice equals "API round-trips per slice" by construction.
2. The `usage` blob is identical across rows of one response. Per-`requestId` is the natural aggregation unit.
3. It mirrors the user mental model: the unit of accounting is the API round-trip, not the streaming flush window.

### Filter set (single shared predicate)

The eligibility predicate is extracted into one helper used by both the inference emitter and `dedupeUsagesByRequestId`. This is the critical correctness invariant: filter drift between the two would recreate the count discrepancy on any turn containing API errors.

```js
function isCanonicalAssistantRecord(rec) {
  if (rec?.type !== 'assistant') return false;
  if (rec.isApiErrorMessage) return false;
  if (typeof rec.requestId !== 'string' || !rec.requestId) return false;
  if (!rec.message?.usage) return false;
  return true;
}
```

`dedupeUsagesByRequestId` is refactored to call this helper. So is the new inference builder. Equivalence of `inferences.length` and `agent_trace.turn.request_count` becomes a single-site invariant.

### Schema for the unified `inference` span

```
{
  name: 'inference',
  spanId, parentSpanId, startMs, endMs, durationMs,
  attributes: {
    'gen_ai.request.model': string,
    'gen_ai.response.id': string,
    'agent_trace.inference.request_id': string,
    'gen_ai.usage.input_tokens': number,
    'gen_ai.usage.output_tokens': number,
    'gen_ai.usage.cache_read_tokens': number,
    'gen_ai.usage.cache_creation_tokens': number,
    'agent_trace.response.stop_reason'?: string,        // omit when absent
    'agent_trace.inference.prompt'?: string,            // structural walk back to prior assistant row
    'agent_trace.inference.has_thinking': boolean,
    'agent_trace.inference.has_text': boolean,
    'agent_trace.inference.has_tool_use': boolean,
    'agent_trace.inference.tool_use_ids'?: string[],    // tool_use block ids emitted by this response
  },
  events: [
    // Emitted iff the corresponding content was present and non-empty after truncation.
    // Same OTel-semconv names as today's turn-root events; only the parent span changes.
    { name: 'gen_ai.assistant.reasoning', timeMs, attributes: { 'gen_ai.reasoning.content': string } },
    { name: 'gen_ai.assistant.message',   timeMs, attributes: { 'gen_ai.message.content':   string } },
  ],
  children: [/* tool spans emitted by this inference's tool_use blocks; see Reparenting */],
}
```

Design notes:

- **No `kind` enum.** Three booleans (`has_thinking`/`has_text`/`has_tool_use`) carry the same information without a `'mixed'` smell and without an illegal-state risk (where a `kind: 'text'` span could be paired with a reasoning event).
- **Content lives in `events`, not in attributes.** Preserves CLAUDE.md §7 OTel semconv compliance. `gen_ai.assistant.message` and `gen_ai.assistant.reasoning` remain *events* with the same attribute schemas. Only the parent moves from turn root to inference span.
- **`tool_use` blocks are not events on the inference.** They become child tool spans (existing behavior, just re-parented — see Reparenting). The `tool_use_ids` attribute lets readers cross-link from inference attributes to child tool spans without walking the tree.

### Timing (slice-clamped)

For each `requestId` group inside a slice (`startIdx..endIdx`):

- **`startMs`**: timestamp of the record immediately preceding the *first* row of the group within the slice. If the first row is at `slice.startIdx`, fall back to the slice's own `startMs`. Walk is bounded by `Math.max(0, slice.startIdx - 1)`; never crosses a slice boundary.
- **`endMs`**: timestamp of the *last* row of the group within the slice.
- **Drop** the group from spans if `endMs <= startMs` (CLAUDE.md §6: no zero-duration spans). Increment `agent_trace.turn.dropped_zero_duration_inferences` for observability.
- **Per-`requestId` grouping is slice-local.** If a `requestId` ever straddles a slice boundary (in practice this should not happen — one `requestId` is one API call, contained in one turn), each slice gets its own inference span for the rows it contains. This is defensive and honors §5a.

### Content aggregation (per `requestId`)

Within the slice-clamped group, walk rows in JSONL order (CLAUDE.md §2 forbids ordering decisions on timestamps):

- Concatenate any `block.thinking` plaintext (newline-joined). Truncate the *combined* result at `ASSISTANT_MAX = 16000`. Emit `gen_ai.assistant.reasoning` event iff non-empty.
- Concatenate any `block.text` (newline-joined). Truncate the *combined* result at `ASSISTANT_MAX`. Emit `gen_ai.assistant.message` event iff non-empty.
- Collect each `tool_use` block's `id` into `agent_trace.inference.tool_use_ids` (omit attribute if empty).
- Set `has_thinking` / `has_text` / `has_tool_use` from the union of block types observed across the group's rows.
- Take `usage` from the first row of the group (it is identical across rows by API contract).
- `stop_reason`: scan rows in JSONL order from last to first; take the first non-empty value. Omit the attribute when no row has one.

### Tool span reparenting

Tool spans today are siblings of inference spans under the turn root. With one inference span per `requestId` covering the whole response, tool spans are re-parented under the inference whose `tool_use` block produced them.

Mechanism:

- Each `tool_use` content block carries a unique `id`. The inference span aggregates these into `tool_use_ids`.
- When building tool spans, look up which inference's `tool_use_ids` contains this `tool_use.id` and parent the tool span under that inference span.
- If no matching inference is found (defensive — shouldn't happen given they share a slice), fall back to parenting under the turn root.

Topology change visible to readers:

```
turn:N
  inference            (was: nothing rendered for tool_use-only round-trips)
    Bash               (was: parented under turn:N)
  inference
    Read               (was: parented under turn:N)
    Edit
  inference
    Agent
      subagent:<type>
        inference
          Bash
```

### Subagent path

`buildSubagentSpan` (~`lib/traces/traces.js:671`) follows the same rule. Each subagent transcript produces one `inference` span per `requestId` in that transcript, with the same schema. Tool spans inside a subagent are reparented under their emitting subagent inference. `agent_trace.subagent.request_count` (`:748`) continues to use `dedupeUsagesByRequestId` — same predicate, same number, equal to count of inference children of the subagent root by construction.

### Empty/error responses

Per the canonical predicate, `isApiErrorMessage` records are excluded — they are not counted as inferences, not summed into token aggregates, and not part of the request_count. This is consistent with current behavior for token aggregates and is explicit for the inference set after this plan.

## Implementation plan

### Phase 1 — Transformer change (single PR)

**File: `lib/traces/traces.js`**

1. Extract `isCanonicalAssistantRecord` as a top-level helper. Refactor `dedupeUsagesByRequestId` (`:441–457`) to call it.

2. Replace `buildInferenceSpans(rec, recIdx, ...)` (per-row, thinking-only, `:513–597`) with `buildInferenceSpansForSlice(records, startIdx, endIdx, parentSpanId)`:
   - Iterates `records[startIdx..endIdx]` in JSONL order.
   - Filters via `isCanonicalAssistantRecord`.
   - Groups by `rec.requestId`, preserving first-seen order.
   - For each group: compute slice-clamped `startMs`/`endMs`, aggregate content/`has_*` flags, emit one inference span. Drop and count if `endMs <= startMs`.

3. Replace per-row call sites of the old emitter inside the turn-slice loop (`:1421` area) with one call to `buildInferenceSpansForSlice` per slice. Audit and remove any remaining per-row callers.

4. **Subagent path**: replace per-row emission in `buildSubagentSpan` with `buildInferenceSpansForSlice(records, 0, records.length - 1, subagentSpanId)`. Ensure subagent-level `extractAssistantEvents` no longer emits `gen_ai.assistant.message` / `gen_ai.assistant.reasoning` to the subagent root — those events now live on the subagent's inference spans.

5. **Turn-root events**: update `extractAssistantEvents` so `gen_ai.assistant.message` and `gen_ai.assistant.reasoning` are no longer emitted to the turn root. Other event types (context attachments, hooks) remain on the turn root unchanged because they are not tied to a specific API call.

6. **Tool-span reparenting**: when assembling a slice's children, build a map `tool_use_id → inference_span_id` from each inference's `tool_use_ids`. Parent each tool span under the matching inference span. Fall back to the turn root if no match. Apply the same logic in the subagent path.

7. **Hook attachment**: hooks attached to tool spans via `tool_use_id` (CLAUDE.md side-channel logic, `:1487–1496`) are unaffected — they pair to the tool span itself, whose identity does not change. Verify no hook handler implicitly assumes "tool spans are children of the turn root."

8. Verify `agent_trace.turn.request_count` (`:1523`) numerically equals the count of `name === 'inference'` direct children of the turn root after this change. Same for `agent_trace.subagent.request_count`. Add a transformer-level assertion (cheap, fail-loud).

**Phase 1 acceptance:**

- `inferences.length` per turn (counted as `name === 'inference'` direct children of the turn root) equals `agent_trace.turn.request_count` for every fixture transcript.
- Same equivalence holds for every subagent: `inference` children of the subagent root vs `agent_trace.subagent.request_count`.
- Both equivalences hold on a fixture that contains an `isApiErrorMessage: true` assistant record (filter-drift regression).
- For session `80a43f04…` turn 2: exactly 9 inference spans as direct children of `turn:2`, with `has_*` distribution matching the JSONL profile (2× thinking+tool_use, 5× tool_use-only, 1× text+tool_use, 1× text-only, 1× tool_use-only with text — count is from raw JSONL).
- Token aggregates per turn (`input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens`) are bit-for-bit identical to the pre-change pipeline.
- Tool spans in the new tree are reachable as descendants of inference spans (or, for orphans, of the turn root) — total tool-span count per turn unchanged.
- `agent_trace.tool.name`, `agent_trace.tool.input_summary`, `agent_trace.tool.output_summary`, and tool-result hook attachments are unchanged.
- Subagent pairing (CLAUDE.md §2) and `unattached` trace emission are unchanged.

### Phase 2 — Documentation

`CLAUDE.md` is already updated alongside this plan to reflect the new vocabulary (tool calls explicitly not inferences; one inference per `requestId`; UI applies the rendering policy). No further docs work in Phase 2.

### Phase 3 — UI follow-up (out of scope for this plan)

Documented separately. The UI follow-up will:

- Drop the `'assistant-message'` step kind in `transforms.ts` (its data source — turn-root events — is gone after Phase 1).
- Migrate the chat surface (`TurnMessages.tsx`, `ChatMessage.tsx`) to read `gen_ai.assistant.message` events from inference spans.
- Update Steps glyph derivation to read `has_thinking`/`has_text`/`has_tool_use`.
- Verify chart footer counts align with Overview's "N inferences" automatically (no chart code change required).
- Decide whether to render parent inference spans for `tool_use`-only round-trips or suppress them visually (a UI policy choice; the state will support both).

The Phase 1 transformer change is content-additive in the sense that **the existing UI continues to work between Phase 1 and Phase 3**: the chat surface reads `gen_ai.assistant.message` events that now live on inference spans rather than the turn root, but as long as the UI's event-walk traverses descendants (or is updated to do so as a one-line change), no Phase 3 work is strictly required to keep the app functional. **In practice** the UI walks turn-root events directly, so Phase 1 will visibly empty the chat surface until Phase 3 lands. Sequencing options:

1. Land Phase 1 + a one-line UI patch that walks turn-descendant events for the chat surface, deferring the rest of the UI work to Phase 3.
2. Land Phase 1 + Phase 3 together as a coordinated change.

Either is acceptable; the choice is operational, not architectural.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Filter drift between `dedupeUsagesByRequestId` and the inference emitter, recreating the count discrepancy. | Both call `isCanonicalAssistantRecord`. Phase 1 acceptance criterion 1 is the regression guard. |
| Subagent inference emission missed during migration. | Explicitly in Phase 1 step 4. Acceptance criterion 2 verifies it. |
| OTel semconv regression. | Avoided. Content stays as `gen_ai.assistant.message` / `gen_ai.assistant.reasoning` *events* with their existing attribute schemas; only the parent moves. |
| Tool-span reparenting orphans tool calls if `tool_use_id` matching fails. | Defensive fallback to turn root. Acceptance criterion 7 verifies total tool-span count is unchanged. |
| Hook attachment via `tool_use_id` breaks because tool spans have a new parent. | Hook handlers pair to tool spans by `tool_use_id`, not by parent. Phase 1 step 7 audits. |
| Multi-thinking-row responses lose per-window granularity. | Acceptable — the unit of accounting is the API round-trip. CLAUDE.md is updated to reflect this. Per-row spans were always carrying duplicate `usage` data deduped elsewhere. |
| Streaming-partial-flush `has_*` flag flicker between polls. | Flags are monotone (false→true only) as more rows of the same `requestId` arrive. The `requestId` itself is the stable identity. |
| Token aggregates drift. | Cannot — both old and new pipelines call `dedupeUsagesByRequestId`, which now shares its filter with the inference emitter. |
| UI temporarily empty between Phase 1 and Phase 3. | Acknowledged in §"UI follow-up." Either land a one-line UI patch alongside Phase 1, or coordinate Phases 1 and 3. |

## Files touched

**Modified (this plan):**
- `lib/traces/traces.js` — extract `isCanonicalAssistantRecord`; rewrite `buildInferenceSpans` → `buildInferenceSpansForSlice`; relocate assistant-content event emission from turn/subagent roots to inference spans; reparent tool spans under their emitting inference; migrate the subagent path; add the dropped-zero-duration counter.
- `CLAUDE.md` — already updated alongside this plan: vocabulary (tool calls are not inferences), emission rule (one per `requestId`), topology example, anti-patterns, no-duplication policy attribution.

**Unchanged (this plan):**
- `lib/traces/sessions.js`, `lib/traces/transcripts.js`, `lib/traces/store.js` (I/O layer).
- All subagent-pairing, slash-command, hook, and context-attachment logic in `traces.js` (other than the tool-span reparenting touch).
- All UI files (deferred to Phase 3).

## Validation

1. **Filter-drift regression test.** Fixture with at least one `isApiErrorMessage: true` assistant record. Per turn: `inferences.length === agent_trace.turn.request_count`, both excluding the error record.
2. **Per-`requestId` count test.** Session `80a43f04…` turn 2: exactly 9 inference spans. `has_*` flag distribution matches the raw JSONL profile.
3. **Token-aggregate parity test.** For every fixture session: per-turn `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens` are bit-for-bit identical before and after.
4. **Subagent parity test.** For fixtures with subagents: per-subagent `inference` child count equals `agent_trace.subagent.request_count`. Subagent token aggregates unchanged.
5. **Tool-span count test.** For every fixture: total tool-span count per turn (counted across the whole turn subtree) is unchanged. Tool-span attributes (`agent_trace.tool.name`, input/output summaries) are unchanged.
6. **Hook attachment test.** Hooks paired via `tool_use_id` continue to attach to the same tool span (verified by `spanId` of the parent tool span before and after — same `tool_use_id`, same tool span identity).
7. **Streaming-flicker test.** Synthetic transcript representing a partially-flushed multi-row response, then complete. Same `requestId` → one inference span in both cases; `has_*` flags monotonically gain `true`; no inference appears or disappears between polls.
8. **Slice-clamp test.** Synthetic transcript where consecutive turns share assistant records of overlapping `requestId`s (defensive — should not occur in real transcripts). Each slice emits its own inference span for the rows it contains; no cross-slice timestamps walked.

// @ts-check
// Pure transformer: Claude Code transcript records → TraceSummary[].
// No I/O. Deterministic. One trace per turn (OTel-conventional); session is
// an attribute (`session.id`) on each trace root.
//
// Trace topology per session file:
//   Trace { kind: 'turn', root: turn:N, ... }
//     turn:N                         event_type=turn; one per user-prompt record
//       hook:<Event>                 pre-first-turn hooks relocate onto turn 1
//       <ToolName>                   duration = tool_result.ts − tool_use.ts
//         hook:<Event>               PreToolUse/PostToolUse nested under tool
//       Agent                        subagent spawn via Agent/Task tool
//         subagent:<agentType>       event_type=subagent
//           <nested tool spans …>
//
//   Trace { kind: 'turn' }           ← slash-command turn (case A)
//     turn:N     prompt = "/cmd args"
//       Skill    synthetic; attrs: agent_trace.tool.slash_command
//         subagent:<agentType>       attached only when session has exactly
//                                     one slash triad (1-to-1 by construction,
//                                     no timestamps). Multi-triad sessions:
//                                     subagents fall through to `unattached`.
//
//   Trace { kind: 'unattached', root: subagents:unattached, ... } (optional)
//     subagent:<agentType>           unpaired (Skill-dispatched, etc.)
//
// Side-channel information (hooks, permission-mode changes, command
// permissions) is modeled through a pure handler registry that emits
// SideEffect descriptions; a single interpreter applies them. Adding a new
// attachment type is a one-line registry entry — no if/else chain.

import { isTaskNotification } from './trace-filters.js';

/** @typedef {import('./transcripts.js').TranscriptRecord} TranscriptRecord */
/** @typedef {import('./transcripts.js').SubagentTranscript} SubagentTranscript */
/** @typedef {import('./transcripts.js').TranscriptBundle} TranscriptBundle */

/**
 * @typedef {{
 *   spanId: string,
 *   parentSpanId: string | null,
 *   name: string,
 *   startMs: number,
 *   endMs: number,
 *   durationMs: number,
 *   status?: { code?: number, message?: string },
 *   attributes: Record<string, unknown>,
 *   events: Array<{ name: string, timeMs?: number, attributes?: Record<string, unknown> }>,
 *   children: SpanNode[],
 * }} SpanNode
 */

/**
 * @typedef {{
 *   input: number,
 *   output: number,
 *   cacheRead: number,
 *   cacheCreation: number,
 * }} TurnTokens
 */

/**
 * One user-prompt → agent-actions → agent-response exchange.
 *
 * INVARIANT: top-level scalar fields are a pure projection of values already
 * on `root.attributes` / `root.events`. `root.*` is authoritative; top-level
 * is a convenience mirror computed at transform time. SpanDetail reads from
 * `root` directly; list-level UI (ConversationList, ChatMessage header) reads
 * from the top-level mirrors.
 *
 * @typedef {{
 *   kind: 'turn',
 *   traceId: string,
 *   sessionId: string,
 *   turnNumber: number,
 *   userPrompt: string,
 *   startMs: number,
 *   endMs: number,
 *   durationMs: number,
 *   toolCount: number,
 *   errorCount: number,
 *   isMeta: boolean,
 *   isRunning: boolean,
 *   model: string | null,
 *   finalMode: string | null,
 *   cwd: string | null,
 *   contextTokens: TurnTokens,
 *   attachmentCount: number,
 *   attachmentBytes: number,
 *   root: SpanNode,
 * }} Turn
 */

/**
 * Skill-dispatched subagent subtree with no paired tool_use in the main
 * transcript. No prompt, no response — not a conversational turn.
 *
 * @typedef {{
 *   kind: 'unattached',
 *   traceId: string,
 *   sessionId: string,
 *   startMs: number,
 *   endMs: number,
 *   durationMs: number,
 *   toolCount: number,
 *   errorCount: number,
 *   isRunning: boolean,
 *   cwd: string | null,
 *   root: SpanNode,
 * }} UnattachedGroup
 */

/**
 * @typedef {Turn | UnattachedGroup} TraceSummary
 */

/**
 * @typedef {
 *   | { kind: 'event', event: { name: string, timeMs?: number, attributes?: Record<string, unknown> } }
 *   | { kind: 'sessionAttr', key: string, value: unknown }
 *   | {
 *       kind: 'addSpan',
 *       parent: 'tool' | 'current',
 *       toolUseId?: string | null,
 *       name: string,
 *       startMs: number,
 *       endMs: number,
 *       attributes: Record<string, unknown>,
 *       status?: { code?: number, message?: string },
 *     }
 * } SideEffect
 */

// Cap for tool inputs/outputs (log-like; truncation loses rows, tolerable).
const SUMMARY_MAX = 4000;
// Cap for assistant message / reasoning content (narrative; needs more room
// to avoid mangling conclusions). Thinking blocks routinely hit 5–20 KB.
const ASSISTANT_MAX = 16000;

const EVENT_TYPE = {
  TURN: 'turn',
  SUBAGENT_GROUP: 'subagent_group',
  SUBAGENT: 'subagent',
  HOOK: 'hook',
};

/**
 * True when a span is "structural" — a session/turn/subagent/hook/inference
 * wrapper, not user-facing tool work. Single source of truth; the UI
 * (`ui/src/components/conversation/transforms.ts:countTools`) re-implements
 * this verbatim and MUST stay in sync with this predicate.
 *
 * @param {SpanNode} node
 * @returns {boolean}
 */
function isStructuralSpan(node) {
  return Boolean(node.attributes?.['agent_trace.event_type'])
    || node.name === 'inference';
}

/**
 * Recursively tally tool leaves under a span. "Tool" = any non-structural
 * descendant (see `isStructuralSpan`). `errors` counts spans with
 * status.code === 2.
 *
 * @param {SpanNode} span
 * @returns {{ tools: number, errors: number }}
 */
function countToolSpans(span) {
  let tools = 0;
  let errors = 0;
  const walk = (n) => {
    if (!isStructuralSpan(n)) {
      tools++;
      if (n.status?.code === 2) errors++;
    }
    for (const c of n.children) walk(c);
  };
  for (const c of span.children) walk(c);
  return { tools, errors };
}

/**
 * True if any span in the subtree (root included) carries
 * `agent_trace.in_progress`. Deterministic given transcript bytes —
 * the flag is a transcript-observable property, not wall-clock.
 *
 * @param {SpanNode} node
 * @returns {boolean}
 */
function hasRunningDescendant(node) {
  if (node.attributes?.['agent_trace.in_progress']) return true;
  for (const c of node.children) {
    if (hasRunningDescendant(c)) return true;
  }
  return false;
}

/**
 * Return the mode of the last `agent.mode.changed` event in the list, or
 * null if none. Events are assumed to be time-sorted by the caller.
 *
 * @param {SpanNode['events']} events
 * @returns {string | null}
 */
function finalModeFrom(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.name !== 'agent.mode.changed') continue;
    const mode = ev.attributes?.['agent_trace.mode.current'];
    if (typeof mode === 'string' && mode) return mode;
  }
  return null;
}

/**
 * @param {unknown} v
 * @param {number} [max] — per-call cap; defaults to SUMMARY_MAX (tool I/O).
 */
function truncate(v, max = SUMMARY_MAX) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : safeStringify(v);
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

/** @param {unknown} v */
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** @param {string | number | undefined | null} ts */
function toMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

let idCounter = 0;
function nextSpanId() {
  idCounter = (idCounter + 1) | 0;
  return `s${idCounter.toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * @param {{
 *   name: string,
 *   startMs: number,
 *   endMs: number,
 *   parentSpanId: string | null,
 *   spanId?: string,
 *   attributes?: Record<string, unknown>,
 *   status?: { code?: number, message?: string },
 *   events?: SpanNode['events'],
 *   children?: SpanNode[],
 * }} input
 * @returns {SpanNode}
 */
function makeSpan({
  name,
  startMs,
  endMs,
  parentSpanId,
  spanId,
  attributes = {},
  status,
  events = [],
  children = [],
}) {
  const end = Math.max(startMs, endMs);
  return {
    spanId: spanId ?? nextSpanId(),
    parentSpanId,
    name,
    startMs,
    endMs: end,
    durationMs: end - startMs,
    ...(status ? { status } : {}),
    attributes,
    events,
    children,
  };
}

/**
 * Return the user prompt text from a user-message record, or null if the
 * message is a tool_result (continuation, not a turn boundary).
 * @param {TranscriptRecord} rec
 */
function extractPrompt(rec) {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.every((b) => b?.type === 'tool_result')) return null;
    const textBlock = content.find((b) => b?.type === 'text' || typeof b?.text === 'string');
    if (textBlock) return String(textBlock.text ?? '');
  }
  return null;
}

/**
 * Return the text that triggered an inference — the user message, tool_result
 * content, or text block that the model responded to. Distinct from
 * `extractPrompt`: that helper intentionally returns `null` for tool_result-only
 * records so turn-slicing can detect boundaries; that null is load-bearing and
 * must not be weakened. This helper is exhaustive over the real trigger shapes
 * an inference span can resolve via parentUuid.
 * @param {TranscriptRecord} rec
 * @returns {string}
 */
function triggerPromptText(rec) {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const toolResult = content.find((b) => b?.type === 'tool_result');
  if (toolResult) {
    const inner = toolResult.content;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) {
      return inner
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    return '';
  }
  const textBlock = content.find((b) => b?.type === 'text' && typeof b?.text === 'string');
  return textBlock ? String(textBlock.text) : '';
}

/**
 * @param {TranscriptRecord} rec
 * @returns {Array<{ id: string, name: string, input: unknown }>}
 */
function extractToolUses(rec) {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? 'tool'), input: b.input }));
}

/**
 * Index tool_results from a record list by `tool_use_id`. For records with
 * a top-level `toolUseResult` (richer metadata from Claude Code), capture
 * `agentId` too — it's the deterministic link to a subagent file.
 *
 * @param {TranscriptRecord[]} records
 */
function indexToolResults(records) {
  /** @type {Map<string, { endMs: number, isError: boolean, content: unknown, agentId: string | null, outputBytes: number, outputTokens: number, planApproved: boolean, planFilePath: string | null, rowIndex: number | null }>} */
  const byId = new Map();
  for (const rec of records) {
    if (rec.type !== 'user') continue;
    const endMs = toMs(rec.timestamp);
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    const agentId =
      typeof rec?.toolUseResult?.agentId === 'string' ? rec.toolUseResult.agentId : null;
    const totalTokensRaw = rec?.toolUseResult?.totalTokens;
    const outputTokens =
      typeof totalTokensRaw === 'number' && Number.isFinite(totalTokensRaw)
        ? totalTokensRaw
        : 0;
    // Plan-mode adjudication: when the harness stamps the canonical accepted
    // plan into `toolUseResult.plan` alongside `filePath`, the user approved.
    // Absence is the only structural signal we have for non-approval until a
    // rejection fixture is captured.
    const planText = rec?.toolUseResult?.plan;
    const planFilePathRaw = rec?.toolUseResult?.filePath;
    const planApproved =
      typeof planText === 'string' && typeof planFilePathRaw === 'string';
    const planFilePath = planApproved ? String(planFilePathRaw) : null;
    const rowIndex =
      typeof rec._rowIndex === 'number' ? rec._rowIndex : null;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      byId.set(String(b.tool_use_id ?? ''), {
        endMs,
        isError: Boolean(b.is_error),
        content: b.content,
        agentId,
        outputBytes: byteLength(b.content),
        outputTokens,
        planApproved,
        planFilePath,
        rowIndex,
      });
    }
  }
  return byId;
}

/**
 * UTF-8 byte length of arbitrary tool_result content. Strings measured directly;
 * structured payloads stringified first. Falsy/empty → 0.
 *
 * @param {unknown} v
 */
function byteLength(v) {
  if (v == null) return 0;
  const s = typeof v === 'string' ? v : safeStringify(v);
  if (!s) return 0;
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Eligibility predicate for "an assistant record that counts as part of an
 * API round-trip." Shared by `dedupeUsagesByRequestId` and the inference
 * emitter so token aggregates and inference spans pick the same set of
 * records: both are a 1:1 reflection of distinct `requestId`s.
 *
 * @param {TranscriptRecord} rec
 */
function isCanonicalAssistantRecord(rec) {
  if (rec?.type !== 'assistant') return false;
  if (rec.isApiErrorMessage) return false;
  if (typeof rec.requestId !== 'string' || !rec.requestId) return false;
  if (!rec?.message?.usage) return false;
  return true;
}

/**
 * First eligible record for a given `requestId` across an iterable of
 * record indices, in JSONL order. Used by both the inference emitter (to
 * source `usage` / `model` / `id` from the same row dedupe picks) and any
 * other caller that needs the canonical row of a response.
 *
 * @param {TranscriptRecord[]} records
 * @param {string} requestId
 * @param {Iterable<number>} indices
 * @returns {TranscriptRecord | null}
 */
function findCanonicalRecord(records, requestId, indices) {
  for (const i of indices) {
    if (i < 0 || i >= records.length) continue;
    const r = records[i];
    if (!isCanonicalAssistantRecord(r)) continue;
    if (r.requestId === requestId) return r;
  }
  return null;
}

/**
 * Collect one `usage` blob per distinct `requestId` across an iterable of
 * record indices. A single API response can flush as multiple assistant
 * JSONL rows (one per content block) that all carry the same `requestId`
 * and identical `usage`; summing per row would double-count.
 *
 * @param {TranscriptRecord[]} records
 * @param {Iterable<number>} indices  — slice's record indices, sparse
 * @returns {any[]}  usage blobs, one per distinct requestId
 */
function dedupeUsagesByRequestId(records, indices) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const i of indices) {
    if (i < 0 || i >= records.length) continue;
    const rec = records[i];
    if (!isCanonicalAssistantRecord(rec)) continue;
    if (seen.has(rec.requestId)) continue;
    seen.add(rec.requestId);
    out.push(rec.message.usage);
  }
  return out;
}

/**
 * Sum input / output / cache_read / cache_creation tokens across an
 * iterable of `usage` blobs. Pure; composes with `dedupeUsagesByRequestId`.
 *
 * @param {Iterable<any>} usages
 * @returns {{ input: number, output: number, cacheRead: number, cacheCreation: number }}
 */
function totalUsage(usages) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const usage of usages) {
    if (!usage) continue;
    input += Number(usage.input_tokens ?? 0);
    output += Number(usage.output_tokens ?? 0);
    cacheRead += Number(usage.cache_read_input_tokens ?? 0);
    cacheCreation += Number(usage.cache_creation_input_tokens ?? 0);
  }
  return { input, output, cacheRead, cacheCreation };
}

/**
 * Build inference spans for a slice — one span per distinct `requestId`,
 * regardless of what content the response carried.
 *
 * The state layer mirrors API round-trips 1:1 (CLAUDE.md "Core vocabulary —
 * inference vs. tool call"). One `requestId` is one inference. Whatever
 * content the response emitted (thinking / text / tool_use, or any
 * combination) becomes either an event on this span (reasoning, message)
 * or a child tool span (tool_use). The UI decides how to render based on
 * the `agent_trace.inference.kind` attribute.
 *
 * Returns the inference spans plus a transient `tool_use_id → spanId` map
 * the caller threads into `buildToolSpans` so each tool span nests under
 * the inference whose `tool_use` block emitted it.
 *
 * @param {TranscriptRecord[]} records
 * @param {Iterable<number>} indices  — slice's record indices, sparse, sorted
 * @param {string} parentSpanId
 * @param {Map<string, TranscriptRecord>} [byUuid]  — uuid index for prompt-chain walk
 * @returns {{ inferences: SpanNode[], toolUseToInference: Map<string, string> }}
 */
function buildInferenceSpansForSlice(records, indices, parentSpanId, byUuid) {
  const sliceIdxArr = Array.from(indices, Number).filter(
    (i) => i >= 0 && i < records.length,
  );
  sliceIdxArr.sort((a, b) => a - b);
  const sliceIdxSet = new Set(sliceIdxArr);
  /** @type {Map<string, number[]>} */
  const groups = new Map(); // requestId → row indices, in JSONL order
  /** @type {string[]} */
  const order = []; // requestIds in first-seen order

  for (const i of sliceIdxArr) {
    const rec = records[i];
    if (!isCanonicalAssistantRecord(rec)) continue;
    const id = rec.requestId;
    let bucket = groups.get(id);
    if (!bucket) {
      bucket = [];
      groups.set(id, bucket);
      order.push(id);
    }
    bucket.push(i);
  }

  /** @type {SpanNode[]} */
  const inferences = [];
  /** @type {Map<string, string>} */
  const toolUseToInference = new Map();

  for (const requestId of order) {
    const rowIdxs = /** @type {number[]} */ (groups.get(requestId));
    const firstIdx = rowIdxs[0];
    const lastIdx = rowIdxs[rowIdxs.length - 1];
    const canonical = /** @type {TranscriptRecord} */ (records[firstIdx]);
    const msg = canonical.message ?? {};
    const u = msg.usage ?? {};

    // Aggregate content across all rows of this response.
    const thinkingParts = [];
    const textParts = [];
    /** @type {string[]} */
    const toolUseIds = [];
    let hasThinking = false;
    let hasText = false;
    let hasToolUse = false;
    let stopReason = '';
    for (const rowIdx of rowIdxs) {
      const rec = records[rowIdx];
      const blocks = rec?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const recStop = typeof rec?.message?.stop_reason === 'string' ? rec.message.stop_reason : '';
      if (recStop && !stopReason) stopReason = recStop;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'thinking') {
          hasThinking = true;
          if (typeof b.thinking === 'string' && b.thinking.trim()) {
            thinkingParts.push(b.thinking);
          }
        } else if (b.type === 'text') {
          hasText = true;
          if (typeof b.text === 'string' && b.text.trim()) {
            textParts.push(b.text);
          }
        } else if (b.type === 'tool_use') {
          hasToolUse = true;
          if (typeof b.id === 'string' && b.id) toolUseIds.push(b.id);
        }
      }
    }

    // Timing: span the full response window. startMs is the timestamp of
    // the most-recent slice record before the first row of this group;
    // endMs is the last row's timestamp. Sparse-aware — walks slice indices
    // only, never sweeps records that belong to a different turn.
    let startMs = 0;
    for (let k = sliceIdxArr.indexOf(firstIdx) - 1; k >= 0; k--) {
      const t = records[sliceIdxArr[k]] ? toMs(records[sliceIdxArr[k]].timestamp) : 0;
      if (t) { startMs = t; break; }
    }
    if (!startMs) startMs = toMs(records[sliceIdxArr[0]]?.timestamp) || 0;
    let endMs = toMs(records[lastIdx].timestamp) || startMs;
    if (!startMs && !endMs) continue; // can't place this inference at all
    if (endMs <= startMs) endMs = startMs + 1; // mirrors buildSlashSkillSpan

    // Prompt: walk parentUuid from the canonical row upward, collecting
    // non-assistant records (tool_results, user prompts, attachments) until
    // the chain hits an assistant row of a different requestId or leaves
    // the slice. Structural, not timestamp-based (CLAUDE.md §2).
    /** @type {TranscriptRecord[]} */
    const triggerRecords = [];
    if (byUuid) {
      let cur = canonical.parentUuid ? byUuid.get(canonical.parentUuid) : null;
      let guard = 0;
      while (cur && guard++ < 4096) {
        const idx = records.indexOf(cur);
        if (idx >= 0 && !sliceIdxSet.has(idx)) break;
        if (cur.type === 'assistant') {
          if (cur.requestId !== requestId) break;
        } else {
          triggerRecords.unshift(cur);
        }
        if (typeof cur.parentUuid !== 'string' || !cur.parentUuid) break;
        cur = byUuid.get(cur.parentUuid);
      }
    }
    const promptText = triggerRecords.map(triggerPromptText).filter(Boolean).join('\n\n');

    // Determine the `kind` discriminator: priority is reasoning > message >
    // tool_use, with `mixed` for any combination of two or more.
    /** @type {'reasoning' | 'message' | 'tool_use' | 'mixed'} */
    let kind;
    const kindCount = (hasThinking ? 1 : 0) + (hasText ? 1 : 0) + (hasToolUse ? 1 : 0);
    if (kindCount > 1) kind = 'mixed';
    else if (hasThinking) kind = 'reasoning';
    else if (hasText) kind = 'message';
    else if (hasToolUse) kind = 'tool_use';
    else kind = 'reasoning'; // empty response — defensive default

    /** @type {Record<string, unknown>} */
    const attributes = {
      'gen_ai.request.model': typeof msg.model === 'string' ? msg.model : '',
      'gen_ai.response.id': typeof msg.id === 'string' ? msg.id : '',
      'agent_trace.inference.request_id': requestId,
      'gen_ai.usage.input_tokens': Number(u.input_tokens ?? 0),
      'gen_ai.usage.output_tokens': Number(u.output_tokens ?? 0),
      'gen_ai.usage.cache_read_tokens': Number(u.cache_read_input_tokens ?? 0),
      'gen_ai.usage.cache_creation_tokens': Number(u.cache_creation_input_tokens ?? 0),
      'agent_trace.inference.kind': kind,
    };
    if (stopReason) attributes['agent_trace.response.stop_reason'] = stopReason;
    if (promptText) attributes['agent_trace.inference.prompt'] = truncate(promptText);
    if (typeof canonical._rowIndex === 'number') {
      attributes['agent_trace.transcript.row_index'] = canonical._rowIndex;
      const lastRec = records[lastIdx];
      if (lastRec && typeof lastRec._rowIndex === 'number' && lastRec._rowIndex !== canonical._rowIndex) {
        attributes['agent_trace.transcript.row_index_end'] = lastRec._rowIndex;
      }
    }

    /** @type {SpanNode['events']} */
    const events = [];
    const eventTimeMs = toMs(canonical.timestamp) || startMs;
    if (hasThinking) {
      events.push({
        name: 'gen_ai.assistant.reasoning',
        timeMs: eventTimeMs,
        attributes: {
          'gen_ai.reasoning.content':
            thinkingParts.length > 0
              ? truncate(thinkingParts.join('\n'), ASSISTANT_MAX)
              : '',
        },
      });
    }
    if (textParts.length > 0) {
      /** @type {Record<string, unknown>} */
      const messageAttrs = {
        'gen_ai.message.content': truncate(textParts.join('\n'), ASSISTANT_MAX),
      };
      if (stopReason) messageAttrs['agent_trace.response.stop_reason'] = stopReason;
      events.push({
        name: 'gen_ai.assistant.message',
        timeMs: eventTimeMs,
        attributes: messageAttrs,
      });
    }

    const spanId = nextSpanId();
    const span = {
      spanId,
      parentSpanId,
      name: 'inference',
      startMs,
      endMs,
      durationMs: endMs - startMs,
      attributes,
      events,
      children: /** @type {SpanNode[]} */ ([]),
    };
    inferences.push(span);

    for (const toolUseId of toolUseIds) {
      toolUseToInference.set(toolUseId, spanId);
    }
  }

  return { inferences, toolUseToInference };
}

/**
 * Build the list of tool spans from an assistant message. Nests subagents
 * under Agent/Task tool spans when `toolUseResult.agentId` matches a
 * subagent file.
 *
 * @param {TranscriptRecord} rec
 * @param {ReturnType<typeof indexToolResults>} resultIndex
 * @param {string} parentSpanId
 * @param {number} fallbackEndMs
 * @param {Map<string, SubagentTranscript>} subagentsById  // consumed as used
 * @returns {SpanNode[]}
 */
function buildToolSpans(rec, resultIndex, parentSpanId, fallbackEndMs, subagentsById) {
  const startMs = toMs(rec.timestamp);
  const uses = extractToolUses(rec);
  return uses.map((u) => {
    const result = resultIndex.get(u.id);
    const endMs = result?.endMs ?? fallbackEndMs ?? startMs;
    /** @type {Record<string, unknown>} */
    const attributes = {
      'agent_trace.tool.name': u.name,
      'agent_trace.tool.use_id': u.id,
      'agent_trace.tool.input_summary': truncate(u.input),
    };
    if (typeof rec._rowIndex === 'number') {
      attributes['agent_trace.transcript.row_index'] = rec._rowIndex;
    }
    if (result) {
      attributes['agent_trace.tool.output_summary'] = truncate(result.content);
      attributes['agent_trace.tool.output_bytes'] = result.outputBytes;
      if (result.outputTokens > 0) {
        attributes['agent_trace.tool.output_tokens'] = result.outputTokens;
      }
      if (
        typeof result.rowIndex === 'number' &&
        typeof rec._rowIndex === 'number' &&
        result.rowIndex > rec._rowIndex
      ) {
        attributes['agent_trace.transcript.row_index_end'] = result.rowIndex;
      }
    }
    /** @type {SpanNode['status']} */
    const status = result?.isError ? { code: 2, message: 'tool error' } : undefined;

    // Description is the short human-readable label the parent model emitted
    // on the dispatch (e.g. "Audit tabular numerals"). Tool_use input is the
    // recorded dispatch — sidecar `description` is a fallback we don't need
    // here because every Agent/Task/Skill tool_use carries it inline.
    const descriptionInput = /** @type {any} */ (u.input)?.description;
    if (typeof descriptionInput === 'string' && descriptionInput.trim()) {
      attributes['agent_trace.subagent.description'] = truncate(descriptionInput);
    }

    // Plan-mode adjudication. The plan body lives on input_summary; the user
    // reply on output_summary. Tagging here lets the UI route on attribute
    // instead of tool name, while leaving the span structurally a tool span.
    if (u.name === 'ExitPlanMode') {
      attributes['agent_trace.tool.is_plan_response'] = true;
      attributes['agent_trace.tool.plan_approved'] = result?.planApproved ?? false;
      const planFilePath =
        result?.planFilePath ??
        (typeof /** @type {any} */ (u.input)?.planFilePath === 'string'
          ? /** @type {any} */ (u.input).planFilePath
          : null);
      if (typeof planFilePath === 'string' && planFilePath) {
        attributes['agent_trace.tool.plan_file_path'] = planFilePath;
      }
    }

    /** @type {SpanNode[]} */
    let children = [];
    const pairedAgentId = result?.agentId;
    if (pairedAgentId && subagentsById.has(pairedAgentId)) {
      const sub = /** @type {SubagentTranscript} */ (subagentsById.get(pairedAgentId));
      subagentsById.delete(pairedAgentId);
      const subType =
        sub.agentType ??
        (typeof /** @type {any} */ (u.input)?.subagent_type === 'string'
          ? /** @type {any} */ (u.input).subagent_type
          : 'unknown');
      children = [buildSubagentSpan(sub, subType, parentSpanId, endMs)];
      attributes['agent_trace.subagent.type'] = subType;
      attributes['agent_trace.subagent.id'] = sub.agentId;
      const promptInput = /** @type {any} */ (u.input)?.prompt;
      if (typeof promptInput === 'string' && promptInput.trim()) {
        attributes['agent_trace.subagent.task'] = truncate(promptInput);
      }
    }

    return makeSpan({
      name: u.name,
      startMs,
      endMs,
      parentSpanId,
      attributes,
      status,
      children,
    });
  });
}

/**
 * Build `subagent:<type>` span + nested tool spans from a subagent transcript.
 *
 * @param {SubagentTranscript} sub
 * @param {string} subagentType
 * @param {string | null} parentSpanId
 * @param {number} fallbackEndMs
 * @returns {SpanNode}
 */
function buildSubagentSpan(sub, subagentType, parentSpanId, fallbackEndMs) {
  const records = sub.records;
  const spanId = nextSpanId();
  if (records.length === 0) {
    return {
      spanId,
      parentSpanId,
      name: `subagent:${subagentType}`,
      startMs: fallbackEndMs,
      endMs: fallbackEndMs,
      durationMs: 0,
      attributes: {
        'agent_trace.event_type': EVENT_TYPE.SUBAGENT,
        'agent_trace.subagent.id': sub.agentId,
        'agent_trace.subagent.type': subagentType,
        'agent_trace.subagent.input_tokens': 0,
        'agent_trace.subagent.output_tokens': 0,
        'agent_trace.subagent.cache_read_tokens': 0,
        'agent_trace.subagent.cache_creation_tokens': 0,
        'agent_trace.subagent.request_count': 0,
      },
      events: [],
      children: [],
    };
  }
  const startMs = toMs(records[0].timestamp) || fallbackEndMs;
  const endMs = toMs(records[records.length - 1].timestamp) || fallbackEndMs;
  const resultIndex = indexToolResults(records);
  /** @type {Map<string, SubagentTranscript>} */
  const noNested = new Map();
  /** @type {SpanNode[]} */
  const children = [];
  /** @type {SpanNode['events']} */
  const events = [];
  /** @type {string | undefined} */
  let modelId = undefined;

  // One inference span per distinct requestId across the whole subagent
  // transcript. Tool spans (built per-row below) nest under the inference
  // whose tool_use block emitted them via toolUseToInference.
  /** @type {Map<string, TranscriptRecord>} */
  const byUuid = new Map();
  for (const r of records) {
    if (typeof r?.uuid === 'string' && r.uuid) byUuid.set(r.uuid, r);
  }
  const allIndices = records.map((_, i) => i);
  const { inferences, toolUseToInference } = buildInferenceSpansForSlice(
    records,
    allIndices,
    spanId,
    byUuid,
  );
  for (const inf of inferences) children.push(inf);

  /** @type {Map<string, SpanNode>} */
  const inferenceById = new Map();
  for (const inf of inferences) inferenceById.set(inf.spanId, inf);

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.type !== 'assistant') continue;
    if (!modelId && rec?.message?.model) modelId = String(rec.message.model);
    const nextAssistantTs =
      records.slice(i + 1).find((r) => r.type === 'assistant')?.timestamp ??
      records[records.length - 1]?.timestamp;
    for (const span of buildToolSpans(
      rec,
      resultIndex,
      spanId,
      toMs(nextAssistantTs) || endMs,
      noNested,
    )) {
      const useId = span.attributes?.['agent_trace.tool.use_id'];
      const parentInfId = typeof useId === 'string' ? toolUseToInference.get(useId) : undefined;
      const parentInf = parentInfId ? inferenceById.get(parentInfId) : undefined;
      if (parentInf) {
        span.parentSpanId = parentInf.spanId;
        parentInf.children.push(span);
      } else {
        children.push(span);
      }
    }
  }
  let firstPrompt = null;
  for (const rec of records) {
    if (rec.type !== 'user') continue;
    const p = extractPrompt(rec);
    if (p) { firstPrompt = p; break; }
  }
  const subUsages = dedupeUsagesByRequestId(records, allIndices);
  const subTotals = totalUsage(subUsages);
  /** @type {Record<string, unknown>} */
  const attributes = {
    'agent_trace.event_type': EVENT_TYPE.SUBAGENT,
    'agent_trace.subagent.id': sub.agentId,
    'agent_trace.subagent.type': subagentType,
    'agent_trace.subagent.input_tokens': subTotals.input,
    'agent_trace.subagent.output_tokens': subTotals.output,
    'agent_trace.subagent.cache_read_tokens': subTotals.cacheRead,
    'agent_trace.subagent.cache_creation_tokens': subTotals.cacheCreation,
    'agent_trace.subagent.request_count': subUsages.length,
  };
  if (modelId) attributes['gen_ai.request.model'] = modelId;
  if (firstPrompt) attributes['agent_trace.subagent.task'] = truncate(firstPrompt);
  // Row index of the subagent's first record + scope. Stamp scope on every
  // descendant span so the UI labels rows as "Subagent #N" (per-file numbering).
  const firstSubRec = records[0];
  if (firstSubRec && typeof firstSubRec._rowIndex === 'number') {
    attributes['agent_trace.transcript.row_index'] = firstSubRec._rowIndex;
  }
  const scope = `subagent:${sub.agentId}`;
  attributes['agent_trace.transcript.scope'] = scope;
  /** @param {SpanNode} node */
  const tagScope = (node) => {
    if (node.attributes && !('agent_trace.transcript.scope' in node.attributes)) {
      node.attributes['agent_trace.transcript.scope'] = scope;
    }
    for (const c of node.children) tagScope(c);
  };
  for (const c of children) tagScope(c);
  return {
    spanId,
    parentSpanId,
    name: `subagent:${subagentType}`,
    startMs,
    endMs: Math.max(startMs, endMs),
    durationMs: Math.max(0, endMs - startMs),
    attributes,
    events,
    children,
  };
}

/**
 * Build the synthetic `Skill` tool span for a slash-command turn. Timestamps
 * used here set span *width* in the waterfall — pure display, no pairing or
 * routing decisions. See CLAUDE.md §2: the no-timestamps rule forbids
 * timestamp-driven *decisions*, not timestamp-driven *display*.
 *
 * @param {Extract<TurnSlice, { kind: 'slash' }>} slice
 * @param {TranscriptRecord[]} records
 * @param {string} turnSpanId
 * @returns {SpanNode}
 */
function buildSlashSkillSpan(slice, records, turnSpanId) {
  const invoTs = toMs(records[slice.slashMeta.invocationIdx].timestamp);
  const stdoutTs =
    slice.slashMeta.stdoutIdx != null
      ? toMs(records[slice.slashMeta.stdoutIdx].timestamp)
      : invoTs;
  return makeSpan({
    name: 'Skill',
    parentSpanId: turnSpanId,
    startMs: invoTs,
    // durationMs > 0 invariant (CLAUDE.md §6). Interrupted commands have
    // stdoutTs === invoTs; the +1ms bump keeps the waterfall honest.
    endMs: Math.max(stdoutTs, invoTs + 1),
    attributes: {
      'agent_trace.tool.name': 'Skill',
      'agent_trace.tool.slash_command': slice.slashMeta.commandName,
      'agent_trace.tool.input_summary': truncate(slice.slashMeta.argsText),
    },
  });
}

/**
 * Attach unpaired subagents to the synthetic Skill span when the session has
 * exactly ONE slash-command turn. 1-to-1 by construction — no timestamps
 * used for pairing. Multi-triad sessions: no structural subagent→triad link
 * exists; leftovers stay in `subagentsById` and flow to the `unattached`
 * trace below (safety valve). See CLAUDE.md §2.
 *
 * After attaching, widen the Skill span and the turn span to cover the actual
 * subagent execution window. In case A the triad records are flushed at
 * end-of-command with identical timestamps while the subagents ran minutes
 * earlier — without widening, child spans would render outside their parent
 * in the waterfall. Widening here is a render-bounds update, not a pairing
 * decision.
 *
 * @param {Array<{ turnIdx: number, skillSpan: SpanNode }>} slashTurns
 * @param {Map<string, SubagentTranscript>} subagentsById
 * @param {SpanNode[]} turnSpans
 */
function attachSlashSubagents(slashTurns, subagentsById, turnSpans) {
  if (slashTurns.length !== 1) return;
  const { turnIdx, skillSpan } = slashTurns[0];
  const turnSpan = turnSpans[turnIdx];
  let earliest = skillSpan.startMs;
  let latest = skillSpan.endMs;
  for (const sub of Array.from(subagentsById.values())) {
    // Structural guard — Claude Code marks subagent transcripts with
    // `isSidechain: true` on every record. Anything without it isn't a
    // dispatched subagent and shouldn't be force-attached here.
    if (!sub.records[0]?.isSidechain) continue;
    const subType = sub.agentType ?? 'unknown';
    const subSpan = buildSubagentSpan(sub, subType, skillSpan.spanId, skillSpan.endMs);
    skillSpan.children.push(subSpan);
    skillSpan.attributes['agent_trace.subagent.type'] = subType;
    skillSpan.attributes['agent_trace.subagent.id'] = sub.agentId;
    subagentsById.delete(sub.agentId);
    if (subSpan.startMs > 0 && subSpan.startMs < earliest) earliest = subSpan.startMs;
    if (subSpan.endMs > latest) latest = subSpan.endMs;
  }
  if (skillSpan.children.length === 0) return;
  // Mutate in place — `turnSpans` is consumed by the emission loop below,
  // which reads startMs/endMs/durationMs off the same node.
  skillSpan.startMs = earliest;
  skillSpan.endMs = Math.max(latest, earliest + 1);
  skillSpan.durationMs = skillSpan.endMs - skillSpan.startMs;
  if (earliest < turnSpan.startMs) turnSpan.startMs = earliest;
  if (latest > turnSpan.endMs) turnSpan.endMs = latest;
  turnSpan.durationMs = Math.max(0, turnSpan.endMs - turnSpan.startMs);
}

// Slash-command detection — see CLAUDE.md §2 "Deterministic subagent pairing".
// The parentUuid chain is the structural contract; sentinel strings are a
// cheap pre-filter.
const SLASH_CAVEAT_TOKEN = '<local-command-caveat>';
const SLASH_INVOCATION_TOKEN = '<command-name>';
const SLASH_STDOUT_TOKEN = '<local-command-stdout>';

/**
 * @typedef {{
 *   caveatIdx: number,
 *   invocationIdx: number,
 *   stdoutIdx: number | null,
 *   commandName: string,
 *   argsText: string,
 * }} SlashMeta
 */

/**
 * A turn slice is the set of record indices that share a turn root. The
 * indices are stored sparsely so a record from a different turn (e.g. a
 * mid-stream user prompt that interrupts an in-flight requestId) can sit
 * between two records of this turn in JSONL order without being swept in.
 *
 * `startIdx` / `endIdx` are derived as `min(indices)` / `max(indices)` for
 * display-bound consumers (timestamps, slash-span widths) only.
 *
 * @typedef {
 *   | { kind: 'turn',  indices: number[], startIdx: number, endIdx: number, prompt: string, isMeta: boolean }
 *   | { kind: 'slash', indices: number[], startIdx: number, endIdx: number, prompt: string, isMeta: false, slashMeta: SlashMeta }
 * } TurnSlice
 */

/**
 * Pull `<command-name>…</command-name>` + `<command-args>…</command-args>`
 * out of a slash-command invocation record's content string. Returns the
 * parsed name (without leading slash) and the args text. Falls back to
 * whitespace-split on the first token after `/` when the XML form is absent.
 *
 * @param {string} content
 * @returns {{ commandName: string, argsText: string }}
 */
function parseSlashInvocation(content) {
  const nameMatch = content.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (nameMatch) {
    return {
      commandName: nameMatch[1],
      argsText: (argsMatch?.[1] ?? '').trim(),
    };
  }
  // Bare `/command args…` form (observed in real transcripts alongside the
  // XML form). Strip the leading slash, take first whitespace-delimited token.
  const trimmed = content.replace(/^\s*\//, '').trimEnd();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { commandName: trimmed, argsText: '' };
  return {
    commandName: trimmed.slice(0, firstSpace),
    argsText: trimmed.slice(firstSpace + 1).trim(),
  };
}

/**
 * True iff `rec` is a real user prompt — the kind that starts a turn. A
 * "real" prompt is a `user` record whose content is a string and which is
 * neither (a) a harness-meta row like `<system-reminder>`, (b) a slash
 * invocation, (c) a slash stdout, nor (d) a task-notification. Slash
 * caveats *are* prompts even though they carry `isMeta: true` — they wrap
 * the user's actual input.
 *
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
function isUserPromptRecord(rec) {
  if (rec?.type !== 'user') return false;
  const content = rec?.message?.content;
  if (typeof content !== 'string' || !content) return false;
  if (isTaskNotification(rec)) return false;
  const trimmed = content.trimStart();
  if (trimmed.startsWith(SLASH_INVOCATION_TOKEN)) return false;
  if (trimmed.startsWith(SLASH_STDOUT_TOKEN)) return false;
  if (trimmed.startsWith(SLASH_CAVEAT_TOKEN)) return true;
  if (rec.isMeta) return false;
  return true;
}

/**
 * Find the nearest user-prompt ancestor of `rec` by walking the parentUuid
 * chain upward. Returns the prompt record itself when called on one.
 *
 * "Nearest" (not "topmost") is the right rule because user prompts often
 * chain to prior user prompts via tool_result lineage — walking past the
 * first one would collapse multi-turn sessions into a single turn.
 *
 * @param {TranscriptRecord} rec
 * @param {Map<string, TranscriptRecord>} byUuid
 * @returns {TranscriptRecord | null}
 */
function findTurnRoot(rec, byUuid) {
  let cur = rec;
  let guard = 0;
  while (cur && guard++ < 4096) {
    if (isUserPromptRecord(cur)) return cur;
    if (typeof cur.parentUuid !== 'string' || !cur.parentUuid) return null;
    cur = byUuid.get(cur.parentUuid);
  }
  return null;
}

/**
 * Recover slash-triad metadata from a bucket of indices whose root is a
 * caveat record. Returns null when the bucket isn't a slash triad.
 *
 * @param {TranscriptRecord} root
 * @param {number[]} indices
 * @param {TranscriptRecord[]} records
 * @returns {SlashMeta | null}
 */
function detectSlashFromBucket(root, indices, records) {
  const rootContent = root?.message?.content;
  if (typeof rootContent !== 'string' || !rootContent.trimStart().startsWith(SLASH_CAVEAT_TOKEN)) {
    return null;
  }
  const caveatIdx = indices.find((i) => records[i].uuid === root.uuid);
  if (caveatIdx === undefined) return null;

  let invocationIdx = -1;
  let stdoutIdx = null;
  for (const i of indices) {
    const r = records[i];
    if (r?.type !== 'user') continue;
    const c = r?.message?.content;
    if (typeof c !== 'string') continue;
    const trimmed = c.trimStart();
    if (invocationIdx === -1 && r.parentUuid === root.uuid && trimmed.startsWith(SLASH_INVOCATION_TOKEN)) {
      invocationIdx = i;
    }
  }
  if (invocationIdx === -1) return null;
  const invocation = records[invocationIdx];
  for (const i of indices) {
    const r = records[i];
    if (r?.type !== 'user') continue;
    if (r.parentUuid !== invocation.uuid) continue;
    const c = r?.message?.content;
    if (typeof c !== 'string') continue;
    if (!c.trimStart().startsWith(SLASH_STDOUT_TOKEN)) continue;
    stdoutIdx = i;
    break;
  }
  const { commandName, argsText } = parseSlashInvocation(invocation.message.content);
  return { caveatIdx, invocationIdx, stdoutIdx, commandName, argsText };
}

/**
 * Walk the main transcript and produce one slice per user-prompt-rooted
 * group, where membership is determined by the parentUuid chain:
 * record R belongs to slice S iff `findTurnRoot(R)` is S's root prompt.
 *
 * Slash-command triads collapse for free — the invocation and stdout
 * records' chains lead back to the caveat, so all three land in the same
 * bucket. Detection of which buckets are slash triads is recovered from
 * the bucket itself.
 *
 * @param {TranscriptRecord[]} records
 * @returns {TurnSlice[]}
 */
function sliceTurns(records) {
  /** @type {Map<string, TranscriptRecord>} */
  const byUuid = new Map();
  for (const r of records) {
    if (typeof r?.uuid === 'string' && r.uuid) byUuid.set(r.uuid, r);
  }

  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  /** @type {string[]} */
  const order = [];
  for (let i = 0; i < records.length; i++) {
    const root = findTurnRoot(records[i], byUuid);
    if (!root) continue;
    const key = root.uuid;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(i);
  }

  /** @type {TurnSlice[]} */
  const slices = [];
  for (const rootUuid of order) {
    const indices = /** @type {number[]} */ (buckets.get(rootUuid));
    indices.sort((a, b) => a - b);
    const root = /** @type {TranscriptRecord} */ (byUuid.get(rootUuid));
    const startIdx = indices[0];
    const endIdx = indices[indices.length - 1];

    const slashMeta = detectSlashFromBucket(root, indices, records);
    if (slashMeta) {
      const prompt = slashMeta.argsText
        ? `/${slashMeta.commandName} ${slashMeta.argsText}`
        : `/${slashMeta.commandName}`;
      slices.push({
        kind: 'slash',
        indices,
        startIdx,
        endIdx,
        prompt,
        isMeta: false,
        slashMeta,
      });
      continue;
    }

    const prompt = extractPrompt(root) ?? '';
    slices.push({
      kind: 'turn',
      indices,
      startIdx,
      endIdx,
      prompt,
      isMeta: Boolean(root.isMeta),
    });
  }
  return slices;
}

// ─────────────────────────────────────────────────────────────────────────────
// Side-channel handlers. Each is pure: (rec, ctx) => SideEffect[].
// Add a new attachment by adding one line to ATTACHMENT_HANDLERS; the fold
// and interpreter stay untouched.

/** @param {TranscriptRecord} rec */
function handleHookAttachment(rec) {
  const att = rec.attachment ?? {};
  const endMs = toMs(rec.timestamp);
  const dur = Number(att.durationMs ?? 0);
  const event = String(att.hookEvent ?? 'unknown');
  const isError =
    att.type === 'hook_non_blocking_error' ||
    att.type === 'hook_cancelled' ||
    Number(att.exitCode ?? 0) !== 0;
  const toolUseId = typeof att.toolUseID === 'string' && att.toolUseID ? att.toolUseID : null;

  /** @type {Record<string, unknown>} */
  const commonAttrs = {
    'agent_trace.hook.name': String(att.hookName ?? ''),
    'agent_trace.hook.event': event,
    'agent_trace.hook.exit_code': Number(att.exitCode ?? 0),
  };
  if (att.command) commonAttrs['agent_trace.hook.command'] = truncate(att.command);
  if (att.stdout) commonAttrs['agent_trace.hook.stdout'] = truncate(att.stdout);
  if (att.stderr) commonAttrs['agent_trace.hook.stderr'] = truncate(att.stderr);

  // Zero-duration hooks preserve the "no marker span" invariant — attach as
  // an event on the enclosing container instead of a degenerate span.
  if (!(dur > 0) || !Number.isFinite(endMs) || endMs === 0) {
    return [
      /** @type {SideEffect} */ ({
        kind: 'event',
        event: {
          name: `hook.${event.toLowerCase()}`,
          timeMs: endMs || undefined,
          attributes: commonAttrs,
        },
      }),
    ];
  }

  return [
    /** @type {SideEffect} */ ({
      kind: 'addSpan',
      parent: toolUseId ? 'tool' : 'current',
      toolUseId,
      name: `hook:${event}`,
      startMs: endMs - dur,
      endMs,
      attributes: { ...commonAttrs, 'agent_trace.event_type': EVENT_TYPE.HOOK },
      status: isError ? { code: 2, message: `hook ${att.type}` } : undefined,
    }),
  ];
}

/**
 * @param {string} nextMode
 * @returns {(rec: TranscriptRecord) => SideEffect[]}
 */
function modeChange(nextMode) {
  return (rec) => {
    const att = rec.attachment ?? {};
    /** @type {Record<string, unknown>} */
    const attrs = {
      'agent_trace.mode.current': nextMode,
      'agent_trace.mode.source': String(att.type ?? ''),
    };
    if (typeof att.planFilePath === 'string') {
      attrs['agent_trace.mode.plan_file_path'] = att.planFilePath;
    }
    return [
      /** @type {SideEffect} */ ({
        kind: 'event',
        event: {
          name: 'agent.mode.changed',
          timeMs: toMs(rec.timestamp) || undefined,
          attributes: attrs,
        },
      }),
    ];
  };
}

/** @param {TranscriptRecord} rec */
function handleCommandPermissions(rec) {
  const tools = rec.attachment?.allowedTools;
  if (!Array.isArray(tools)) return [];
  return [
    /** @type {SideEffect} */ ({
      kind: 'event',
      event: {
        name: 'command.permissions.set',
        timeMs: toMs(rec.timestamp) || undefined,
        attributes: { 'agent_trace.command.allowed_tools': tools.map(String) },
      },
    }),
  ];
}

/**
 * @param {TranscriptRecord} rec
 * @param {{ initialPermissionModeSet: boolean }} ctx
 * @returns {SideEffect[]}
 */
function handlePermissionMode(rec, ctx) {
  const mode = typeof rec.permissionMode === 'string' ? rec.permissionMode : null;
  if (!mode) return [];
  /** @type {SideEffect[]} */
  const out = [
    {
      kind: 'event',
      event: {
        name: 'agent.mode.changed',
        timeMs: toMs(rec.timestamp) || undefined,
        attributes: {
          'agent_trace.mode.current': mode,
          'agent_trace.mode.source': 'permission-mode',
        },
      },
    },
  ];
  if (!ctx.initialPermissionModeSet) {
    out.push({
      kind: 'sessionAttr',
      key: 'agent_trace.session.initial_permission_mode',
      value: mode,
    });
    ctx.initialPermissionModeSet = true;
  }
  return out;
}

/** @type {Record<string, (rec: TranscriptRecord, ctx: any) => SideEffect[]>} */
const ATTACHMENT_HANDLERS = {
  hook_success: handleHookAttachment,
  hook_non_blocking_error: handleHookAttachment,
  hook_cancelled: handleHookAttachment,
  plan_mode: modeChange('plan'),
  plan_mode_reentry: modeChange('plan'),
  plan_mode_exit: modeChange('default'),
  auto_mode: modeChange('auto'),
  auto_mode_exit: modeChange('default'),
  command_permissions: handleCommandPermissions,
};

/**
 * Subtypes intentionally routed through `handleContextAttachment`. Not a
 * switch — only a registry of expected fallthroughs so the catalog-drift
 * test can fail fast when the harness emits a new subtype that hasn't been
 * classified (handle it specifically vs. accept generic byte tracking).
 *
 * Wire contract: changing the byte formula in `handleContextAttachment` is a
 * breaking change to the trace JSON.
 */
const KNOWN_GENERIC_ATTACHMENT_TYPES = Object.freeze([
  'task_reminder',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'nested_memory',
  'edited_text_file',
  'queued_command',
  'file',
  'directory',
  'date_change',
  'already_read_file',
]);

/**
 * Generic fallback handler for attachment subtypes that aren't in
 * `ATTACHMENT_HANDLERS`. Emits one `agent_trace.context.attachment` event
 * carrying the subtype string + a deterministic byte count over the full
 * attachment payload. Shape-agnostic by construction — `safeStringify` works
 * uniformly across string/object/array/null content shapes that different
 * subtypes carry.
 *
 * @param {TranscriptRecord} rec
 * @returns {SideEffect[]}
 */
function handleContextAttachment(rec) {
  const att = rec.attachment ?? {};
  const bytes = Buffer.byteLength(safeStringify(att), 'utf8');
  return [
    /** @type {SideEffect} */ ({
      kind: 'event',
      event: {
        name: 'agent_trace.context.attachment',
        timeMs: toMs(rec.timestamp) || undefined,
        attributes: {
          'agent_trace.attachment.type': String(att.type ?? 'unknown'),
          'agent_trace.attachment.bytes': bytes,
        },
      },
    }),
  ];
}

/** @type {Record<string, (rec: TranscriptRecord, ctx: any) => SideEffect[]>} */
const RECORD_HANDLERS = {
  'permission-mode': handlePermissionMode,
};

/**
 * Pure fold — produces effect descriptions; no mutation.
 *
 * @param {TranscriptRecord[]} records
 * @param {Iterable<number>} indices
 * @param {{ initialPermissionModeSet: boolean }} ctx
 * @returns {SideEffect[]}
 */
function collectSideChannelEffects(records, indices, ctx) {
  /** @type {SideEffect[]} */
  const effects = [];
  for (const i of indices) {
    if (i < 0 || i >= records.length) continue;
    const rec = records[i];
    if (!rec) continue;
    const recFn = RECORD_HANDLERS[rec.type];
    if (recFn) effects.push(...recFn(rec, ctx));
    const attType = rec?.attachment?.type;
    if (!attType) continue;
    if (ATTACHMENT_HANDLERS[attType]) {
      effects.push(...ATTACHMENT_HANDLERS[attType](rec, ctx));
    } else {
      effects.push(...handleContextAttachment(rec));
    }
  }
  return effects;
}

/**
 * Interpret SideEffects into the current container (turn span or, in the
 * pre-turn region, the session root). The only place that mutates spans.
 *
 * @param {SideEffect[]} effects
 * @param {{
 *   currentSpanId: string,
 *   currentChildren: SpanNode[],
 *   currentEvents: SpanNode['events'],
 *   currentStartMs: number,
 *   currentEndMs: number,
 *   toolSpansById: Map<string, SpanNode>,
 *   sessionAttrs: Record<string, unknown>,
 * }} ctx
 */
function applySideChannelEffects(effects, ctx) {
  for (const eff of effects) {
    if (eff.kind === 'event') {
      ctx.currentEvents.push(eff.event);
      continue;
    }
    if (eff.kind === 'sessionAttr') {
      ctx.sessionAttrs[eff.key] = eff.value;
      continue;
    }
    // addSpan — resolve parent, clamp to its window.
    const parent =
      eff.parent === 'tool' && eff.toolUseId && ctx.toolSpansById.has(eff.toolUseId)
        ? /** @type {SpanNode} */ (ctx.toolSpansById.get(eff.toolUseId))
        : null;
    const parentSpanId = parent ? parent.spanId : ctx.currentSpanId;
    const parentChildren = parent ? parent.children : ctx.currentChildren;
    const parentStart = parent ? parent.startMs : ctx.currentStartMs;
    const parentEnd = parent ? parent.endMs : ctx.currentEndMs;
    const clampedStart = Math.max(parentStart, eff.startMs);
    const clampedEndRaw = Math.max(clampedStart, eff.endMs);
    const clampedEnd = parentEnd > 0 ? Math.min(clampedEndRaw, parentEnd) : clampedEndRaw;
    parentChildren.push(
      makeSpan({
        name: eff.name,
        startMs: clampedStart,
        endMs: clampedEnd,
        parentSpanId,
        attributes: eff.attributes,
        status: eff.status,
      }),
    );
  }
}

/**
 * Top-level entry point. Returns one TraceSummary per turn (plus an optional
 * `unattached` trace for Skill-dispatched subagents not paired to a turn).
 *
 * INVARIANT — must iterate turn slices sequentially. Two pieces of state are
 * shared across all slices and cannot be parallelized:
 *   1. `subagentsById` Map — consumed as Agent/Task tool_results pair to
 *      subagent files. Remainder becomes the unattached trace.
 *   2. `sideCtx.initialPermissionModeSet` — ensures the initial permission
 *      mode is captured exactly once across the whole transcript.
 *
 * @param {string} sessionId
 * @param {TranscriptBundle} bundle
 * @returns {TraceSummary[]}
 */
export function toTraces(sessionId, bundle) {
  const records = bundle.main;
  // Some leading records are metadata with no timestamp (permission-mode,
  // file-history-snapshot). Find the first/last record that actually carries one.
  let firstTs = 0;
  let lastTs = 0;
  for (const r of records) {
    const t = toMs(r.timestamp);
    if (!t) continue;
    if (!firstTs) firstTs = t;
    lastTs = t;
  }
  /** @type {Map<string, SubagentTranscript>} */
  const subagentsById = new Map(bundle.subagents.map((s) => [s.agentId, s]));
  const resultIndex = indexToolResults(records);
  /** @type {Map<string, TranscriptRecord>} */
  const byUuid = new Map();
  for (const r of records) {
    if (typeof r?.uuid === 'string' && r.uuid) byUuid.set(r.uuid, r);
  }
  const turnSlices = sliceTurns(records);

  // Authoritative project path from the transcript itself — every record
  // carries `cwd`. Using the filesystem slug (~/.claude/projects/<slug>) would
  // be lossy (spaces, dashes in directory names don't round-trip).
  const cwd =
    records.find((r) => typeof r?.cwd === 'string' && r.cwd)?.cwd ?? null;

  /** Session-level attributes stamped onto every trace root at emission time. */
  /** @type {Record<string, unknown>} */
  const sessionAttrs = {
    'session.id': sessionId,
    'agent_trace.harness': 'claude-code',
    ...(cwd ? { 'agent_trace.session.cwd': cwd } : {}),
  };
  /** Pre-turn side-channel output; relocated onto turn 1's root (or dropped). */
  /** @type {SpanNode[]} */
  const preTurnChildren = [];
  /** @type {SpanNode['events']} */
  const preTurnEvents = [];
  const sideCtx = { initialPermissionModeSet: false };

  // Pre-turn region — SessionStart hooks, initial permission-mode.
  // Use a throwaway parentSpanId; children get re-parented to turn 1 at emission.
  const preTurnParentId = nextSpanId();
  const preTurnEnd = turnSlices.length > 0 ? turnSlices[0].startIdx - 1 : records.length - 1;
  if (preTurnEnd >= 0) {
    const preTurnIndices = [];
    for (let i = 0; i <= preTurnEnd; i++) preTurnIndices.push(i);
    const preEffects = collectSideChannelEffects(records, preTurnIndices, sideCtx);
    applySideChannelEffects(preEffects, {
      currentSpanId: preTurnParentId,
      currentChildren: preTurnChildren,
      currentEvents: preTurnEvents,
      currentStartMs: firstTs,
      currentEndMs: lastTs || firstTs,
      toolSpansById: new Map(),
      sessionAttrs,
    });
  }

  /** @type {SpanNode[]} */
  const turnSpans = [];
  /** @type {number[]} */
  const turnToolCounts = [];
  /** @type {number[]} */
  const turnErrorCounts = [];
  /** Slash-command turns, used by the post-loop pairing pass to nest
   * unpaired subagents under the synthetic Skill span (single-triad case only
   * — see `attachSlashSubagents`). */
  /** @type {Array<{ turnIdx: number, skillSpan: SpanNode }>} */
  const slashTurns = [];
  /** Per-turn metadata captured alongside the root span, used at emission
   * time to populate Turn.{model, contextTokens, userPrompt, turnNumber,
   * isMeta}. Local loop vars (modelId, inputTokens, …) go out of scope
   * before the emission loop, so we thread them out here. */
  /** @type {Array<{
   *   turnNumber: number,
   *   userPrompt: string,
   *   isMeta: boolean,
   *   model: string | null,
   *   contextTokens: TurnTokens,
   *   attachmentCount: number,
   *   attachmentBytes: number,
   * }>} */
  const turnMetaList = [];

  for (let t = 0; t < turnSlices.length; t++) {
    const slice = turnSlices[t];
    const turnNumber = t + 1;
    const startMs = toMs(records[slice.startIdx].timestamp);
    let endMs = toMs(records[slice.endIdx].timestamp);
    const turnSpanId = nextSpanId();

    /** @type {SpanNode[]} */
    const turnChildren = [];
    /** @type {SpanNode['events']} */
    const turnEvents = [];
    /** @type {Map<string, SpanNode>} */
    const toolSpansById = new Map();
    let modelId = /** @type {string | undefined} */ (undefined);
    // Per-request inference index: one entry per distinct Anthropic API call.
    // A single response can flush as multiple JSONL rows with identical
    // usage; summing per row double-counts. Token totals fold the index
    // through `totalUsage`; per-request detail lives on each inference span
    // emitted under the turn root.
    const dedupedUsages = dedupeUsagesByRequestId(records, slice.indices);
    const {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheCreation: cacheCreationTokens,
    } = totalUsage(dedupedUsages);
    let turnTools = 0;
    let turnErrors = 0;

    // Slash-command turn: emit the synthetic Skill span as the first child
    // before the regular assistant-record sweep (which is a no-op for slash
    // triads since the main transcript has no assistant records between the
    // caveat and stdout).
    if (slice.kind === 'slash') {
      const skillSpan = buildSlashSkillSpan(slice, records, turnSpanId);
      turnChildren.push(skillSpan);
      turnTools++;
      slashTurns.push({ turnIdx: t, skillSpan });
      // Triad records share one flush timestamp — widen the turn to at least
      // contain the Skill span so the waterfall is well-formed.
      if (skillSpan.endMs > endMs) endMs = skillSpan.endMs;
    }

    // One inference span per distinct requestId in the slice. Tool spans
    // (built per-row below) nest under the inference whose tool_use block
    // emitted them via toolUseToInference.
    const { inferences, toolUseToInference } = buildInferenceSpansForSlice(
      records,
      slice.indices,
      turnSpanId,
      byUuid,
    );
    for (const inf of inferences) turnChildren.push(inf);
    /** @type {Map<string, SpanNode>} */
    const inferenceById = new Map();
    for (const inf of inferences) inferenceById.set(inf.spanId, inf);

    const sliceIdxArr = slice.indices;
    for (let k = 0; k < sliceIdxArr.length; k++) {
      const i = sliceIdxArr[k];
      const rec = records[i];
      if (rec.type !== 'assistant') continue;
      if (!modelId && rec?.message?.model) modelId = String(rec.message.model);

      // Next assistant within this slice's records (sparse-aware).
      let nextAssistantTs = records[sliceIdxArr[sliceIdxArr.length - 1]].timestamp;
      for (let j = k + 1; j < sliceIdxArr.length; j++) {
        const r = records[sliceIdxArr[j]];
        if (r?.type === 'assistant') { nextAssistantTs = r.timestamp; break; }
      }

      for (const span of buildToolSpans(
        rec,
        resultIndex,
        turnSpanId,
        toMs(nextAssistantTs) || endMs,
        subagentsById,
      )) {
        const useId = span.attributes?.['agent_trace.tool.use_id'];
        const parentInfId =
          typeof useId === 'string' ? toolUseToInference.get(useId) : undefined;
        const parentInf = parentInfId ? inferenceById.get(parentInfId) : undefined;
        if (parentInf) {
          span.parentSpanId = parentInf.spanId;
          parentInf.children.push(span);
        } else {
          turnChildren.push(span);
        }
        if (typeof useId === 'string' && useId) toolSpansById.set(useId, span);
        turnTools++;
        if (span.status?.code === 2) turnErrors++;
      }
    }

    // Apply side-channel effects AFTER tool spans exist — hook handlers
    // resolve their parent via tool_use_id.
    const effects = collectSideChannelEffects(records, slice.indices, sideCtx);
    applySideChannelEffects(effects, {
      currentSpanId: turnSpanId,
      currentChildren: turnChildren,
      currentEvents: turnEvents,
      currentStartMs: startMs,
      currentEndMs: Math.max(startMs, endMs),
      toolSpansById,
      sessionAttrs,
    });

    // Stable-sort events by time so readers (UI timeline, SpanDetail) see
    // them in chronological order. Undefined timeMs sorts first.
    turnEvents.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));

    // Fold context-attachment events into per-turn aggregates. Single pass
    // over events already collected — no second walk over `records`.
    let attachmentCount = 0;
    let attachmentBytes = 0;
    for (const ev of turnEvents) {
      if (ev.name !== 'agent_trace.context.attachment') continue;
      attachmentCount++;
      attachmentBytes += Number(ev.attributes?.['agent_trace.attachment.bytes'] ?? 0);
    }

    /** @type {Record<string, unknown>} */
    const turnAttrs = {
      'agent_trace.event_type': EVENT_TYPE.TURN,
      'agent_trace.turn.number': turnNumber,
      'agent_trace.prompt': truncate(slice.prompt),
      'agent_trace.turn.is_meta': slice.isMeta,
      'agent_trace.turn.input_tokens': inputTokens,
      'agent_trace.turn.output_tokens': outputTokens,
      'agent_trace.turn.cache_read_tokens': cacheReadTokens,
      'agent_trace.turn.cache_creation_tokens': cacheCreationTokens,
      'agent_trace.turn.context_tokens': inputTokens + cacheReadTokens + cacheCreationTokens,
      'agent_trace.turn.request_count': dedupedUsages.length,
      'agent_trace.turn.attachment_count': attachmentCount,
      'agent_trace.turn.attachment_bytes': attachmentBytes,
    };
    if (modelId) turnAttrs['gen_ai.request.model'] = modelId;
    const firstSliceRec = records[slice.indices[0]];
    if (firstSliceRec && typeof firstSliceRec._rowIndex === 'number') {
      turnAttrs['agent_trace.transcript.row_index'] = firstSliceRec._rowIndex;
      const lastSliceRec = records[slice.indices[slice.indices.length - 1]];
      if (
        lastSliceRec &&
        typeof lastSliceRec._rowIndex === 'number' &&
        lastSliceRec._rowIndex !== firstSliceRec._rowIndex
      ) {
        turnAttrs['agent_trace.transcript.row_index_end'] = lastSliceRec._rowIndex;
      }
    }

    turnSpans.push(
      makeSpan({
        name: `turn:${turnNumber}`,
        spanId: turnSpanId,
        startMs,
        endMs: Math.max(startMs, endMs),
        parentSpanId: null,
        attributes: turnAttrs,
        children: turnChildren,
        events: turnEvents,
      }),
    );
    turnToolCounts.push(turnTools);
    turnErrorCounts.push(turnErrors);
    turnMetaList.push({
      turnNumber,
      userPrompt: slice.prompt,
      isMeta: slice.isMeta,
      model: modelId ?? null,
      contextTokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheCreation: cacheCreationTokens,
      },
      attachmentCount,
      attachmentBytes,
    });
  }

  // Pair leftover subagents to the synthetic Skill span when the session
  // has exactly one slash-command turn (1-to-1 by construction, no timestamps).
  // Multi-triad sessions: the pairing pass no-ops and leftovers flow to the
  // unattached trace below — see CLAUDE.md §2.
  attachSlashSubagents(slashTurns, subagentsById, turnSpans);

  // Anything left in subagentsById had no Agent/Task tool_use with a matching
  // toolUseResult.agentId. These are Skill-dispatched or otherwise unlinked.
  /** @type {SpanNode | null} */
  let unattachedGroup = null;
  let unattachedTools = 0;
  let unattachedErrors = 0;
  if (subagentsById.size > 0) {
    /** @type {SpanNode[]} */
    const unattachedChildren = [];
    let groupStart = Number.POSITIVE_INFINITY;
    let groupEnd = 0;
    const groupSpanId = nextSpanId();
    for (const sub of subagentsById.values()) {
      const subType = sub.agentType ?? 'unknown';
      const span = buildSubagentSpan(sub, subType, groupSpanId, lastTs);
      unattachedChildren.push(span);
      groupStart = Math.min(groupStart, span.startMs);
      groupEnd = Math.max(groupEnd, span.endMs);
    }
    for (const sub of unattachedChildren) {
      const counts = countToolSpans(sub);
      unattachedTools += counts.tools;
      unattachedErrors += counts.errors;
    }
    unattachedGroup = {
      spanId: groupSpanId,
      parentSpanId: null,
      name: 'subagents:unattached',
      startMs: groupStart === Number.POSITIVE_INFINITY ? firstTs : groupStart,
      endMs: Math.max(groupStart, groupEnd),
      durationMs: Math.max(0, groupEnd - groupStart),
      attributes: {
        ...sessionAttrs,
        'agent_trace.event_type': EVENT_TYPE.SUBAGENT_GROUP,
        'agent_trace.unattached.count': unattachedChildren.length,
      },
      events: [],
      children: unattachedChildren,
    };
  }

  /** @type {TraceSummary[]} */
  const traces = turnSpans.map((turnSpan, i) => {
    // Relocate pre-turn side-channel output onto turn 1. If there are no
    // turns, pre-turn content is dropped (see guard below).
    const children =
      i === 0 && preTurnChildren.length > 0
        ? [...preTurnChildren, ...turnSpan.children]
        : turnSpan.children;
    const events =
      i === 0 && preTurnEvents.length > 0
        ? [...preTurnEvents, ...turnSpan.events]
        : turnSpan.events;
    /** @type {SpanNode} */
    const root = {
      ...turnSpan,
      attributes: { ...turnSpan.attributes, ...sessionAttrs },
      children,
      events,
    };
    const meta = turnMetaList[i];
    const sessionInitialMode =
      typeof sessionAttrs['agent_trace.session.initial_permission_mode'] ===
      'string'
        ? /** @type {string} */ (sessionAttrs['agent_trace.session.initial_permission_mode'])
        : null;
    /** @type {Turn} */
    const turn = {
      kind: 'turn',
      traceId: `${sessionId}:turn:${meta.turnNumber}`,
      sessionId,
      turnNumber: meta.turnNumber,
      userPrompt: meta.userPrompt,
      startMs: root.startMs,
      endMs: root.endMs,
      durationMs: root.durationMs,
      toolCount: turnToolCounts[i],
      errorCount: turnErrorCounts[i],
      isMeta: meta.isMeta,
      isRunning: hasRunningDescendant(root),
      model: meta.model,
      finalMode: finalModeFrom(root.events) ?? sessionInitialMode,
      cwd,
      contextTokens: meta.contextTokens,
      attachmentCount: meta.attachmentCount,
      attachmentBytes: meta.attachmentBytes,
      root,
    };
    return turn;
  });

  if (unattachedGroup) {
    /** @type {UnattachedGroup} */
    const ua = {
      kind: 'unattached',
      traceId: `${sessionId}:unattached`,
      sessionId,
      startMs: unattachedGroup.startMs,
      endMs: unattachedGroup.endMs,
      durationMs: unattachedGroup.durationMs,
      toolCount: unattachedTools,
      errorCount: unattachedErrors,
      isRunning: hasRunningDescendant(unattachedGroup),
      cwd,
      root: unattachedGroup,
    };
    traces.push(ua);
  }

  return traces;
}

export {
  sliceTurns,
  indexToolResults,
  collectSideChannelEffects,
  dedupeUsagesByRequestId,
  totalUsage,
  isStructuralSpan,
  ATTACHMENT_HANDLERS,
  KNOWN_GENERIC_ATTACHMENT_TYPES,
};

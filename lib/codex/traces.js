// @ts-check
// Pure transformer: Codex rollout rows → TraceSummary[]. No I/O.
// Deterministic. One trace per turn. The state layer mirrors API round-trips
// 1:1 (see CLAUDE.md "Core vocabulary — inference vs. tool call").
//
// Trace topology:
//   Trace { kind: 'turn' }
//     turn:N                      attrs: agent_trace.harness=codex, etc.
//       inference                 one per event_msg.token_count
//         <ToolName>              duration = (output.ts − call.ts) for paired tools
//
// No subagents in Codex → never emits `kind: 'unattached'`.
//
// Structural rules (all per CLAUDE.md §2 — append order, no timestamps for
// identity / pairing / ordering decisions):
//
//   * Turn slicing: each event_msg.task_started opens a turn carrying turn_id.
//     Rows up to the next task_started belong to that turn. Terminal:
//     event_msg.task_complete OR event_msg.turn_aborted with matching turn_id.
//     Neither → isRunning: true (mid-write or genuinely in-flight).
//
//   * Inference slicing: within a turn, one inference =
//     (task_started | prior token_count) exclusive → next token_count
//     inclusive. usage from token_count.last_token_usage.
//
//   * Tool span parenting: each function_call / custom_tool_call /
//     web_search_call parents to the inference whose open-row block it
//     appears in. *_call_output rows are NOT part of any inference —
//     they're the prior tool span's result and implicitly input to the
//     next inference. Tools pair via call_id (scoped per-turn).
//
//   * Synthetic inference id: `${turn_id}:${ordinal}` where ordinal is the
//     0-indexed token_count position within the turn. Codex emits no per-
//     round-trip id on response_item rows, so we synthesise one.
//
//   * Zero-inference turn (turn_aborted before first token_count): emit a
//     turn span with no inference children, stamp
//     agent_trace.turn.truncated: true, drop any orphaned *_call rows.
//
//   * Read-boundary filters apply earlier (transcripts.js):
//     drop session_meta.base_instructions.text,
//     drop response_item.message with role ∈ {user, developer}.
//     The real user prompt comes from event_msg.user_message.message.

/** @typedef {import('./transcripts.js').RolloutRow} RolloutRow */
/** @typedef {import('./transcripts.js').CodexBundle} CodexBundle */

// Wire-format types live in lib/traces/types.d.ts (shared with the UI and
// the Claude Code transformer). Codex never emits `UnattachedGroup` — no
// subagents in this harness — so its transform() returns a strict subset of
// the shared TraceSummary union.
/** @typedef {import('../traces/types.js').SpanNode} SpanNode */
/** @typedef {import('../traces/types.js').TurnTokens} TurnTokens */
/** @typedef {import('../traces/types.js').Turn} Turn */
/** @typedef {import('../traces/types.js').TraceSummary} TraceSummary */

// Truncation caps — mirror the Claude transformer's distinction.
const SUMMARY_MAX = 4000; // tool I/O — log-like, truncation tolerable
const ASSISTANT_MAX = 16000; // narrative content — needs more room

let idCounter = 0;
function nextSpanId() {
  idCounter = (idCounter + 1) | 0;
  return `s${idCounter.toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10)}`;
}

/** @param {string | number | undefined | null} ts */
function toMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v */
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function truncate(v, max = SUMMARY_MAX) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : safeStringify(v);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/** @param {unknown} v */
function byteLength(v) {
  if (v == null) return 0;
  const s = typeof v === 'string' ? v : safeStringify(v);
  if (!s) return 0;
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Detect tool-call error state from the output payload.
 *
 *   - function_call_output: free-form text; look for "Process exited with code N"
 *     where N != 0.
 *   - custom_tool_call_output: output is a JSON-encoded string with
 *     `{output, metadata: {exit_code, duration_seconds}}` — check exit_code.
 *
 * Returns `null` when no signal is present (assume success).
 *
 * @param {string} kind     'function' | 'custom'
 * @param {unknown} output
 * @returns {boolean}
 */
function isToolError(kind, output) {
  if (typeof output !== 'string') return false;
  if (kind === 'custom') {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && parsed.metadata) {
        const ec = parsed.metadata.exit_code;
        return typeof ec === 'number' && ec !== 0;
      }
    } catch {
      // not JSON — fall through to text heuristic
    }
  }
  const m = output.match(/Process exited with code\s+(-?\d+)/);
  if (m) return Number(m[1]) !== 0;
  return false;
}

/**
 * Extract the visible text from a response_item.message payload (assistant
 * role). The transcripts.js filter already dropped user/developer messages.
 *
 * @param {any} payload
 * @returns {string}
 */
function assistantMessageText(payload) {
  const content = payload?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * @typedef {{
 *   turnId: string,
 *   startIdx: number,
 *   indices: number[],            // every row idx in JSONL order for this turn
 *   terminalKind: 'complete' | 'aborted' | null,
 *   terminalIdx: number | null,
 * }} TurnSlice
 */

/**
 * Walk rows in append order; partition into per-turn slices keyed by
 * event_msg.task_started.turn_id. Rows that appear before the first
 * task_started (session_meta, leading metadata) belong to no turn slice —
 * they're metadata captured separately.
 *
 * @param {RolloutRow[]} rows
 * @returns {TurnSlice[]}
 */
function sliceTurns(rows) {
  /** @type {TurnSlice[]} */
  const slices = [];
  /** @type {TurnSlice | null} */
  let current = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isStart =
      r?.type === 'event_msg' && r.payload?.type === 'task_started' && r.payload?.turn_id;
    if (isStart) {
      if (current) slices.push(current);
      current = {
        turnId: String(r.payload.turn_id),
        startIdx: i,
        indices: [i],
        terminalKind: null,
        terminalIdx: null,
      };
      continue;
    }
    if (!current) continue; // pre-first-turn metadata (session_meta, etc.)
    current.indices.push(i);
    if (r?.type === 'event_msg') {
      const t = r.payload?.type;
      const tid = r.payload?.turn_id;
      if (tid === current.turnId) {
        if (t === 'task_complete') {
          current.terminalKind = 'complete';
          current.terminalIdx = i;
        } else if (t === 'turn_aborted') {
          current.terminalKind = 'aborted';
          current.terminalIdx = i;
        }
      }
    }
  }
  if (current) slices.push(current);
  return slices;
}

/**
 * Find the first turn_context row (in JSONL order) within the slice and
 * return its payload. Codex stamps one per turn; if multiple, first wins.
 *
 * @param {TurnSlice} slice
 * @param {RolloutRow[]} rows
 */
function turnContextOf(slice, rows) {
  for (const i of slice.indices) {
    const r = rows[i];
    if (r?.type === 'turn_context') return r.payload ?? null;
  }
  return null;
}

/**
 * Pull the user prompt for this turn from event_msg.user_message.message.
 * Concatenates multiple if present (Codex usually emits one).
 *
 * @param {TurnSlice} slice
 * @param {RolloutRow[]} rows
 */
function userPromptOf(slice, rows) {
  const parts = [];
  for (const i of slice.indices) {
    const r = rows[i];
    if (r?.type === 'event_msg' && r.payload?.type === 'user_message') {
      const msg = r.payload?.message;
      if (typeof msg === 'string' && msg.trim()) parts.push(msg);
    }
  }
  return parts.join('\n');
}

/**
 * Build one inference span and the tool spans nested under it.
 *
 * Inputs:
 *   - `start`      first row index of this inference (inclusive)
 *   - `end`        token_count row index (the closing flush, inclusive)
 *   - `tokenCount` the token_count payload (for usage attribution)
 *   - `ordinal`    0-indexed position among this turn's token_counts
 *
 * Output rows for *_call inside this window are matched forward across the
 * entire turn by call_id (scoped to this slice's row indices). Output rows
 * are *not* part of any inference's content — they're the tool span's
 * result payload, and they implicitly feed the next inference's input.
 *
 * @param {{
 *   start: number,
 *   end: number,
 *   tokenCount: any,
 *   ordinal: number,
 *   turnId: string,
 *   slice: TurnSlice,
 *   rows: RolloutRow[],
 *   model: string,
 *   parentSpanId: string,
 *   callIdToOutputIdx: Map<string, number>,
 * }} ctx
 * @returns {{ inference: SpanNode, toolErrorCount: number }}
 */
function buildInferenceSpan(ctx) {
  const {
    start,
    end,
    tokenCount,
    ordinal,
    turnId,
    slice,
    rows,
    model,
    parentSpanId,
    callIdToOutputIdx,
  } = ctx;

  const sliceIdxSet = new Set(slice.indices);
  const startTs = toMs(rows[start]?.timestamp);
  const endTs = toMs(rows[end]?.timestamp);
  const inferenceStart = startTs || endTs || 0;
  const inferenceEnd = endTs <= inferenceStart ? inferenceStart + 1 : endTs;
  const requestId = `${turnId}:${ordinal}`;

  const usage = tokenCount?.info?.last_token_usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const cachedInput = Number(usage.cached_input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const reasoningTokens = Number(usage.reasoning_output_tokens ?? 0);
  // Codex's input_tokens is billed-total (includes cache hits); convert to
  // incremental to match Anthropic semantics the UI already uses.
  const incrementalInput = Math.max(0, inputTokens - cachedInput);

  // Aggregate content across rows in [start, end] that are response_items.
  /** @type {string[]} */
  const messageParts = [];
  let hasReasoning = false;
  let reasoningBytes = 0;
  let hasText = false;
  /** @type {SpanNode[]} */
  const toolChildren = [];
  let toolErrorCount = 0;

  for (let i = start; i <= end; i++) {
    if (!sliceIdxSet.has(i)) continue;
    const r = rows[i];
    if (r?.type !== 'response_item') continue;
    const p = r.payload;
    if (!p) continue;
    if (p.type === 'reasoning') {
      hasReasoning = true;
      if (typeof p.encrypted_content === 'string') reasoningBytes += p.encrypted_content.length;
    } else if (p.type === 'message') {
      const text = assistantMessageText(p);
      if (text) {
        hasText = true;
        messageParts.push(text);
      }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const span = buildToolSpan(p.type, p, i, rows, callIdToOutputIdx);
      if (span.status?.code === 2) toolErrorCount++;
      toolChildren.push(span);
    } else if (p.type === 'web_search_call') {
      const span = buildWebSearchSpan(p, i, rows);
      if (span.status?.code === 2) toolErrorCount++;
      toolChildren.push(span);
    }
  }

  // Determine kind discriminator (mirrors Claude's attribute).
  const hasToolUse = toolChildren.length > 0;
  const kindCount = (hasReasoning ? 1 : 0) + (hasText ? 1 : 0) + (hasToolUse ? 1 : 0);
  /** @type {'reasoning' | 'message' | 'tool_use' | 'mixed'} */
  let kind;
  if (kindCount > 1) kind = 'mixed';
  else if (hasReasoning) kind = 'reasoning';
  else if (hasText) kind = 'message';
  else if (hasToolUse) kind = 'tool_use';
  else kind = 'reasoning';

  /** @type {Record<string, unknown>} */
  const attributes = {
    'gen_ai.request.model': model || '',
    'agent_trace.inference.request_id': requestId,
    'gen_ai.usage.input_tokens': incrementalInput,
    'gen_ai.usage.output_tokens': outputTokens + reasoningTokens,
    'gen_ai.usage.cache_read_tokens': cachedInput,
    'gen_ai.usage.cache_creation_tokens': 0,
    'agent_trace.inference.kind': kind,
    'agent_trace.transcript.row_index': end,
    'agent_trace.transcript.row_index_end': end,
  };

  /** @type {SpanNode['events']} */
  const events = [];
  const eventTimeMs = inferenceStart;
  if (hasReasoning) {
    events.push({
      name: 'gen_ai.assistant.reasoning',
      timeMs: eventTimeMs,
      attributes: {
        // Codex reasoning is encrypted_content — we can't surface the text
        // itself, but we record that reasoning occurred and how much.
        'gen_ai.reasoning.content': `[encrypted, ${reasoningBytes} bytes]`,
      },
    });
  }
  if (hasText) {
    events.push({
      name: 'gen_ai.assistant.message',
      timeMs: eventTimeMs,
      attributes: {
        'gen_ai.message.content': truncate(messageParts.join('\n'), ASSISTANT_MAX),
      },
    });
  }

  const spanId = nextSpanId();
  // Re-parent tool spans onto the inference now that we have its id.
  for (const c of toolChildren) {
    c.parentSpanId = spanId;
  }

  return {
    inference: {
      spanId,
      parentSpanId,
      name: 'inference',
      startMs: inferenceStart,
      endMs: inferenceEnd,
      durationMs: inferenceEnd - inferenceStart,
      attributes,
      events,
      children: toolChildren,
    },
    toolErrorCount,
  };
}

/**
 * Build one tool span for a function_call / custom_tool_call open row.
 * Pairs via call_id to find the matching output row in the same turn.
 *
 * @param {'function_call' | 'custom_tool_call'} kind
 * @param {any} payload
 * @param {number} openIdx
 * @param {RolloutRow[]} rows
 * @param {Map<string, number>} callIdToOutputIdx
 * @returns {SpanNode}
 */
function buildToolSpan(kind, payload, openIdx, rows, callIdToOutputIdx) {
  const callId = String(payload.call_id ?? '');
  const name = String(payload.name ?? (kind === 'function_call' ? 'function' : 'custom_tool'));
  const input = kind === 'function_call' ? payload.arguments : payload.input;
  const openTs = toMs(rows[openIdx]?.timestamp);
  const outputIdx = callId ? callIdToOutputIdx.get(callId) : undefined;
  const outRow = outputIdx != null ? rows[outputIdx] : null;
  const outputTs = toMs(outRow?.timestamp);
  const endMs = outputTs > openTs ? outputTs : openTs + 1;

  /** @type {Record<string, unknown>} */
  const attributes = {
    'agent_trace.tool.name': name,
    'agent_trace.tool.use_id': callId,
    'agent_trace.tool.input_summary': truncate(input),
    'agent_trace.transcript.row_index': openIdx,
  };

  /** @type {SpanNode['status']} */
  let status;
  if (outRow) {
    const output = outRow.payload?.output;
    attributes['agent_trace.tool.output_summary'] = truncate(output);
    attributes['agent_trace.tool.output_bytes'] = byteLength(output);
    if (typeof outputIdx === 'number') {
      attributes['agent_trace.transcript.row_index_end'] = outputIdx;
    }
    if (isToolError(kind === 'function_call' ? 'function' : 'custom', output)) {
      status = { code: 2, message: 'tool error' };
    }
  }

  return {
    spanId: nextSpanId(),
    parentSpanId: null, // re-parented by caller once the inference span exists
    name,
    startMs: openTs,
    endMs,
    durationMs: endMs - openTs,
    ...(status ? { status } : {}),
    attributes,
    events: [],
    children: [],
  };
}

/**
 * Build a leaf tool span for a web_search_call row. No paired output row in
 * the response_item stream — Codex emits an event_msg.web_search_end *before*
 * the response_item.web_search_call (the event_msg is the "search just
 * happened" signal). For v1 we treat the call as a leaf with the queries as
 * input summary.
 *
 * @param {any} payload
 * @param {number} openIdx
 * @param {RolloutRow[]} rows
 * @returns {SpanNode}
 */
function buildWebSearchSpan(payload, openIdx, rows) {
  const openTs = toMs(rows[openIdx]?.timestamp);
  const queries = payload?.action?.queries;
  const inputSummary = Array.isArray(queries) ? queries.join('\n') : (payload?.action?.query ?? '');

  /** @type {SpanNode['status']} */
  const status =
    payload?.status === 'completed' ? undefined : { code: 2, message: 'web_search not completed' };

  return {
    spanId: nextSpanId(),
    parentSpanId: null,
    name: 'web_search',
    startMs: openTs,
    endMs: openTs + 1, // leaf — no structural close row
    durationMs: 1,
    ...(status ? { status } : {}),
    attributes: {
      'agent_trace.tool.name': 'web_search',
      'agent_trace.tool.input_summary': truncate(inputSummary),
      'agent_trace.tool.status': String(payload?.status ?? 'unknown'),
      'agent_trace.transcript.row_index': openIdx,
    },
    events: [],
    children: [],
  };
}

/**
 * Recursively tally non-structural (tool) descendants under a span and count
 * errors. Mirrors the Claude transformer's countToolSpans contract.
 *
 * @param {SpanNode} span
 */
function countToolSpans(span) {
  let tools = 0;
  let errors = 0;
  /** @param {SpanNode} n */
  const walk = (n) => {
    // A "structural" span is any wrapper (inference). Anything else is a tool.
    if (n.name !== 'inference') {
      tools++;
      if (n.status?.code === 2) errors++;
    }
    for (const c of n.children) walk(c);
  };
  for (const c of span.children) walk(c);
  return { tools, errors };
}

/**
 * Build the turn span and its inference children for one slice.
 *
 * @param {number} turnNumber
 * @param {TurnSlice} slice
 * @param {RolloutRow[]} rows
 * @param {string} sessionId
 * @param {Record<string, unknown>} sessionAttrs
 * @returns {Turn}
 */
function buildTurn(turnNumber, slice, rows, sessionId, sessionAttrs) {
  const turnSpanId = nextSpanId();
  const ctx = turnContextOf(slice, rows);
  const model = ctx?.model ?? '';
  const cwd = ctx?.cwd ?? sessionAttrs['agent_trace.session.cwd'] ?? null;
  const userPrompt = userPromptOf(slice, rows);

  // Index *_call_output rows by call_id (scoped to this slice).
  /** @type {Map<string, number>} */
  const callIdToOutputIdx = new Map();
  for (const i of slice.indices) {
    const r = rows[i];
    if (r?.type !== 'response_item') continue;
    const t = r.payload?.type;
    if (t === 'function_call_output' || t === 'custom_tool_call_output') {
      const cid = String(r.payload.call_id ?? '');
      if (cid) callIdToOutputIdx.set(cid, i);
    }
  }

  // Collect token_count row indices in JSONL order — each one closes one inference.
  const tokenCountIdxs = [];
  for (const i of slice.indices) {
    const r = rows[i];
    if (r?.type === 'event_msg' && r.payload?.type === 'token_count') tokenCountIdxs.push(i);
  }

  /** @type {SpanNode[]} */
  const inferenceSpans = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turnTools = 0;
  let turnErrors = 0;

  // Inference window: (prev token_count | task_started) exclusive → next token_count inclusive.
  let prevEnd = slice.startIdx; // exclusive open
  for (let ord = 0; ord < tokenCountIdxs.length; ord++) {
    const tcIdx = tokenCountIdxs[ord];
    const tcPayload = rows[tcIdx]?.payload;
    const { inference, toolErrorCount } = buildInferenceSpan({
      start: prevEnd + 1,
      end: tcIdx,
      tokenCount: tcPayload,
      ordinal: ord,
      turnId: slice.turnId,
      slice,
      rows,
      model,
      parentSpanId: turnSpanId,
      callIdToOutputIdx,
    });
    inferenceSpans.push(inference);
    // Fold per-inference usage into turn totals.
    totals.input += Number(inference.attributes['gen_ai.usage.input_tokens'] ?? 0);
    totals.output += Number(inference.attributes['gen_ai.usage.output_tokens'] ?? 0);
    totals.cacheRead += Number(inference.attributes['gen_ai.usage.cache_read_tokens'] ?? 0);
    const { tools } = countToolSpans(inference);
    turnTools += tools;
    turnErrors += toolErrorCount;
    prevEnd = tcIdx;
  }

  // Turn window: from first row to terminal-or-last row.
  const turnStartMs = toMs(rows[slice.startIdx]?.timestamp);
  const lastIdx = slice.indices[slice.indices.length - 1];
  let turnEndMs = toMs(rows[lastIdx]?.timestamp);
  if (turnEndMs < turnStartMs) turnEndMs = turnStartMs + 1;
  if (turnEndMs === turnStartMs) turnEndMs = turnStartMs + 1;

  const isAborted = slice.terminalKind === 'aborted';
  const isRunning = slice.terminalKind === null;
  const isTruncated = tokenCountIdxs.length === 0;

  /** @type {Record<string, unknown>} */
  const turnAttrs = {
    ...sessionAttrs,
    'agent_trace.event_type': 'turn',
    'agent_trace.turn.number': turnNumber,
    'agent_trace.prompt': truncate(userPrompt),
    'agent_trace.turn.is_meta': false,
    'agent_trace.turn.input_tokens': totals.input,
    'agent_trace.turn.output_tokens': totals.output,
    'agent_trace.turn.cache_read_tokens': totals.cacheRead,
    'agent_trace.turn.cache_creation_tokens': 0,
    'agent_trace.turn.context_tokens': totals.input + totals.cacheRead,
    'agent_trace.turn.request_count': tokenCountIdxs.length,
    'agent_trace.turn.attachment_count': 0,
    'agent_trace.turn.attachment_bytes': 0,
    'agent_trace.transcript.row_index': slice.startIdx,
    'agent_trace.transcript.row_index_end': lastIdx,
    'agent_trace.codex.turn_id': slice.turnId,
  };
  if (model) turnAttrs['gen_ai.request.model'] = model;
  if (isAborted) turnAttrs['agent_trace.turn.aborted'] = true;
  if (isRunning) turnAttrs['agent_trace.in_progress'] = true;
  if (isTruncated) turnAttrs['agent_trace.turn.truncated'] = true;

  /** @type {SpanNode} */
  const root = {
    spanId: turnSpanId,
    parentSpanId: null,
    name: `turn:${turnNumber}`,
    startMs: turnStartMs,
    endMs: turnEndMs,
    durationMs: turnEndMs - turnStartMs,
    attributes: turnAttrs,
    events: [],
    children: inferenceSpans,
  };

  return {
    kind: 'turn',
    traceId: `${sessionId}:turn:${turnNumber}`,
    sessionId,
    turnNumber,
    userPrompt,
    startMs: turnStartMs,
    endMs: turnEndMs,
    durationMs: turnEndMs - turnStartMs,
    toolCount: turnTools,
    errorCount: turnErrors,
    isMeta: false,
    isRunning,
    model: model || null,
    finalMode: null,
    cwd: typeof cwd === 'string' ? cwd : null,
    contextTokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreation: 0,
    },
    attachmentCount: 0,
    attachmentBytes: 0,
    root,
  };
}

/**
 * @param {string} sessionId
 * @param {CodexBundle} bundle
 * @returns {TraceSummary[]}
 */
export function toTraces(sessionId, bundle) {
  const rows = bundle.rows ?? [];
  if (rows.length === 0) return [];

  // session_meta → cwd default; turn_context overrides per turn.
  const meta = rows.find((r) => r?.type === 'session_meta');
  const cwd = typeof meta?.payload?.cwd === 'string' ? meta.payload.cwd : null;

  /** @type {Record<string, unknown>} */
  const sessionAttrs = {
    'session.id': sessionId,
    'agent_trace.harness': 'codex',
    ...(cwd ? { 'agent_trace.session.cwd': cwd } : {}),
  };

  const slices = sliceTurns(rows);
  /** @type {TraceSummary[]} */
  const traces = [];
  for (let i = 0; i < slices.length; i++) {
    traces.push(buildTurn(i + 1, slices[i], rows, sessionId, sessionAttrs));
  }
  return traces;
}

export { sliceTurns };

import { extractSlashCommand, stripLocalCommandCaveat } from '@/lib/utils';
import type { ConversationSummary, SpanNode, Turn, UnattachedGroup } from '@/types';

export type TurnOutcome =
  | { kind: 'running' }
  | { kind: 'completed'; text: string }
  | { kind: 'truncated'; text: string }
  | { kind: 'paused' }
  | { kind: 'refused' }
  | { kind: 'silent' };

export interface TurnEntry {
  key: string;
  traceId: string;
  turnSpan: SpanNode;
  label: string;
  prompt: string | null;
  toolCount: number;
  models: string[];
  isMeta: boolean;
  contextTokens: number;
  attachmentCount: number;
  attachmentBytes: number;
  finalMode: string | null;
  outcome: TurnOutcome;
}

export interface UnattachedEntry {
  key: string;
  traceId: string;
  groupSpan: SpanNode;
  subagentCount: number;
  toolCount: number;
  models: string[];
}

function collectDescendantModels(node: SpanNode): string[] {
  const seen = new Set<string>();
  const walk = (n: SpanNode) => {
    const m = n.attributes?.['gen_ai.request.model'];
    if (typeof m === 'string' && m) seen.add(m);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return [...seen];
}

// Keep in sync with `isStructuralSpan` in `lib/traces/traces.js` — that is
// the authoritative definition. Inference spans are wrappers for an API
// call, not user-facing tool work.
export function countTools(n: SpanNode): number {
  const structural = Boolean(n.attributes?.['agent_trace.event_type']) || n.name === 'inference';
  let count = structural ? 0 : 1;
  for (const c of n.children) count += countTools(c);
  return count;
}

const STOP_REASON_ATTR = 'agent_trace.response.stop_reason';
const MESSAGE_CONTENT_ATTR = 'gen_ai.message.content';

function stopReasonOf(event: SpanNode['events'][number]): string | null {
  const raw = event.attributes?.[STOP_REASON_ATTR];
  return typeof raw === 'string' && raw ? raw : null;
}

function messageTextOf(event: SpanNode['events'][number]): string {
  return String(event.attributes?.[MESSAGE_CONTENT_ATTR] ?? '').trim();
}

// Assistant-content events live on inference spans (one per requestId) under
// the turn root. Earlier transcripts emitted them on the turn root directly;
// we walk both so any consumer that previously read `turn.root.events` sees
// the same set.
function collectAssistantContentEvents(turn: SpanNode): SpanNode['events'] {
  const out: SpanNode['events'] = [...turn.events];
  for (const child of turn.children) {
    if (child.name !== 'inference') continue;
    for (const ev of child.events) out.push(ev);
  }
  return out;
}

function latestMessageWithStop(events: SpanNode['events'], stop: string): { text: string } | null {
  let best: { text: string; timeMs: number } | null = null;
  for (const e of events) {
    if (e.name !== 'gen_ai.assistant.message') continue;
    if (stopReasonOf(e) !== stop) continue;
    const text = messageTextOf(e);
    if (!text) continue;
    const timeMs = e.timeMs ?? 0;
    if (!best || timeMs >= best.timeMs) best = { text, timeMs };
  }
  return best ? { text: best.text } : null;
}

function hasAssistantStop(events: SpanNode['events'], stop: string): boolean {
  for (const e of events) {
    if (e.name === 'gen_ai.assistant.message' && stopReasonOf(e) === stop) {
      return true;
    }
  }
  return false;
}

// A "silent" turn with no prompt, no tools, and no context tokens is noise —
// nothing to debug and nothing for the user to read. Every other turn is
// kept. Turns that DID have activity but produced no recognized stop reason
// stay visible; they just don't render an assistant bubble.
export function hasVisibleActivity(entry: TurnEntry): boolean {
  if (entry.outcome.kind !== 'silent') return true;
  if (entry.toolCount > 0) return true;
  if (entry.contextTokens > 0) return true;
  if (entry.prompt && entry.prompt.length > 0) return true;
  return false;
}

// Many transcripts have turns that legitimately end without a text stop reason:
//   - slash commands (/clear, /compact) never call the model.
//   - assistant responses whose final message is pure tool_use carry stop
//     reasons only on non-text events, which the UI doesn't surface.
// Labeling these "(ended unexpectedly)" is misleading — they're just silent.
// Reserve visible outcome labels for the cases we can actually identify.
export function deriveTurnOutcome(turn: Turn): TurnOutcome {
  if (turn.isMeta) return { kind: 'running' };
  if (turn.isRunning) return { kind: 'running' };
  const events = collectAssistantContentEvents(turn.root);
  const completed = latestMessageWithStop(events, 'end_turn');
  if (completed) return { kind: 'completed', text: completed.text };
  const truncated = latestMessageWithStop(events, 'max_tokens');
  if (truncated) return { kind: 'truncated', text: truncated.text };
  if (hasAssistantStop(events, 'pause_turn')) return { kind: 'paused' };
  if (hasAssistantStop(events, 'refusal')) return { kind: 'refused' };
  return { kind: 'silent' };
}

function buildTurnEntry(turn: Turn): TurnEntry {
  const rawPrompt = turn.userPrompt;
  const caveatStripped =
    turn.turnNumber === 1 ? stripLocalCommandCaveat(rawPrompt) : rawPrompt.trim();
  const cleaned = extractSlashCommand(caveatStripped) ?? caveatStripped;
  const { input, cacheRead, cacheCreation } = turn.contextTokens;
  return {
    key: turn.traceId,
    traceId: turn.traceId,
    turnSpan: turn.root,
    label: turn.root.name,
    prompt: cleaned ? cleaned : null,
    toolCount: turn.toolCount,
    models: turn.model ? [turn.model] : [],
    isMeta: turn.isMeta,
    contextTokens: input + cacheRead + cacheCreation,
    attachmentCount: turn.attachmentCount,
    attachmentBytes: turn.attachmentBytes,
    finalMode: turn.finalMode,
    outcome: deriveTurnOutcome(turn),
  };
}

function buildUnattachedEntry(group: UnattachedGroup): UnattachedEntry {
  return {
    key: group.traceId,
    traceId: group.traceId,
    groupSpan: group.root,
    subagentCount: group.root.children.length,
    toolCount: group.toolCount,
    models: collectDescendantModels(group.root),
  };
}

export function collectTurns(conversation: ConversationSummary): TurnEntry[] {
  return conversation.turns.map(buildTurnEntry);
}

export function collectUnattached(conversation: ConversationSummary): UnattachedEntry[] {
  return conversation.unattached.map(buildUnattachedEntry);
}

export type ConversationStepKind =
  | 'user-prompt'
  | 'inference'
  | 'tool'
  | 'assistant-message'
  | 'reasoning';

export interface StepTokens {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

const ZERO_TOKENS: StepTokens = {
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
};

export type ConversationStepVariant = 'plan-response';

export interface ConversationStep {
  id: string;
  traceId: string;
  turnNumber: number | null;
  kind: ConversationStepKind;
  variant?: ConversationStepVariant;
  label: string;
  subtitle: string;
  timeMs: number;
  durationMs: number;
  tokens: StepTokens;
  outputBytes: number;
  outputTokens: number;
  span?: SpanNode;
  text?: string;
  depth: number;
  requestId?: string;
  usage?: InferenceUsage;
  /** spanId of the emitting inference. See RawStep. */
  inferenceSpanId?: string;
}

const TOOL_KIND_LABEL: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Write',
  Bash: 'Bash',
  Glob: 'Search',
  Grep: 'Search',
  Agent: 'Subagent',
  Task: 'Subagent',
  Skill: 'Subagent',
  ToolSearch: 'Search',
};

function inferenceTokens(span: SpanNode): StepTokens {
  return {
    input: Number(span.attributes['gen_ai.usage.input_tokens'] ?? 0),
    cacheRead: Number(span.attributes['gen_ai.usage.cache_read_tokens'] ?? 0),
    cacheCreation: Number(span.attributes['gen_ai.usage.cache_creation_tokens'] ?? 0),
    output: Number(span.attributes['gen_ai.usage.output_tokens'] ?? 0),
  };
}

function toolStepKindLabel(name: string): string {
  if (TOOL_KIND_LABEL[name]) return TOOL_KIND_LABEL[name];
  if (name.startsWith('mcp__')) return 'MCP tool';
  return 'Tool';
}

function toolStepLabel(span: SpanNode): string {
  const name = String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
  const subagentType = span.attributes['agent_trace.subagent.type'];
  if (typeof subagentType === 'string' && subagentType) {
    const description = span.attributes['agent_trace.subagent.description'];
    if (typeof description === 'string' && description.trim()) {
      return `${subagentType}: ${description.trim()}`;
    }
    return `${name}: ${subagentType}`;
  }
  const slash = span.attributes['agent_trace.tool.slash_command'];
  if (typeof slash === 'string' && slash) {
    return `${name}: /${slash}`;
  }
  const summary = span.attributes['agent_trace.tool.input_summary'];
  if (typeof summary === 'string' && summary) {
    const trimmed = summary.replace(/\s+/g, ' ').trim();
    if (trimmed) return `${name}: ${trimmed}`;
  }
  return name;
}

function inferenceLabel(span: SpanNode): string {
  const stop = span.attributes['agent_trace.response.stop_reason'];
  if (typeof stop === 'string' && stop) return `Inference (${stop})`;
  return 'Inference';
}

function inferenceSubtitle(span: SpanNode): string {
  const model = span.attributes['gen_ai.request.model'];
  return typeof model === 'string' && model ? model : 'inference';
}

function isStructuralSpan(span: SpanNode): boolean {
  return Boolean(span.attributes['agent_trace.event_type']) || span.name === 'inference';
}

function walkInferenceAndTool(
  span: SpanNode,
  depth: number,
  emit: (
    step: 'inference' | 'tool',
    span: SpanNode,
    depth: number,
    parentInferenceSpanId: string | null,
  ) => void,
  parentInferenceSpanId: string | null = null,
): void {
  if (span.name === 'inference') {
    emit('inference', span, depth, span.spanId);
    // Tool spans now nest under the inference whose tool_use block emitted
    // them. Descend so they still appear in the Steps list, indented one
    // level deeper than the parent inference. Children inherit *this*
    // inference as their emitting parent — used downstream to look up the
    // correct inferenceIdx, since flat-order proximity breaks when a sibling
    // tool follows a subagent's nested inferences.
    for (const child of span.children) walkInferenceAndTool(child, depth + 1, emit, span.spanId);
    return;
  }
  if (!isStructuralSpan(span)) {
    emit('tool', span, depth, parentInferenceSpanId);
  }
  // A `subagent:<type>` span is structural and not emitted itself, but its
  // children (the tools/inferences run by the subagent) belong one level
  // deeper so the UI can indent them under their parent Agent dispatch.
  const childDepth = span.attributes['agent_trace.event_type'] === 'subagent' ? depth + 1 : depth;
  for (const child of span.children)
    walkInferenceAndTool(child, childDepth, emit, parentInferenceSpanId);
}

interface RawStep {
  kind: ConversationStepKind;
  variant?: ConversationStepVariant;
  timeMs: number;
  durationMs: number;
  tokens: StepTokens;
  outputBytes: number;
  outputTokens: number;
  span?: SpanNode;
  text?: string;
  label: string;
  subtitle: string;
  depth: number;
  requestId?: string;
  usage?: InferenceUsage;
  /**
   * `spanId` of the inference that emitted this step. For inference steps it
   * is the inference's own spanId; for tool/message/reasoning it is the
   * parent inference (the one whose `tool_use` block dispatched the tool, or
   * whose response carried the message/reasoning event). Used downstream to
   * resolve the correct `inferenceIdx` regardless of flat-order interleaving
   * with subagent contents.
   */
  inferenceSpanId?: string;
}

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(s: string): number {
  return s ? TEXT_ENCODER.encode(s).byteLength : 0;
}

function toolOutputBytes(span: SpanNode): number {
  const v = span.attributes['agent_trace.tool.output_bytes'];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toolOutputTokens(span: SpanNode): number {
  const v = span.attributes['agent_trace.tool.output_tokens'];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isPlanResponseSpan(span: SpanNode): boolean {
  return span.attributes['agent_trace.tool.is_plan_response'] === true;
}

function planResponseLabel(span: SpanNode): string {
  const approved = span.attributes['agent_trace.tool.plan_approved'] === true;
  const verb = approved ? 'Approved' : 'Responded to';
  const summary = span.attributes['agent_trace.tool.input_summary'];
  if (typeof summary === 'string' && summary) {
    const firstLine = summary.split(/\r?\n/).find((l) => l.trim()) ?? '';
    const title = firstLine.replace(/^#+\s*/, '').trim();
    if (title) return `${verb} plan: ${title}`;
  }
  return `${verb} plan`;
}

function buildPlanResponseStep(span: SpanNode, depth: number): RawStep {
  return {
    kind: 'tool',
    variant: 'plan-response',
    timeMs: span.startMs,
    durationMs: span.durationMs,
    tokens: ZERO_TOKENS,
    outputBytes: toolOutputBytes(span),
    outputTokens: toolOutputTokens(span),
    span,
    label: planResponseLabel(span),
    subtitle: 'Plan response',
    depth,
  };
}

function stepsForTurn(turn: Turn): RawStep[] {
  const out: RawStep[] = [];
  const promptText = (() => {
    const raw = turn.userPrompt;
    const stripped = turn.turnNumber === 1 ? stripLocalCommandCaveat(raw) : raw.trim();
    return extractSlashCommand(stripped) ?? stripped;
  })();
  if (promptText) {
    out.push({
      kind: 'user-prompt',
      timeMs: turn.startMs,
      durationMs: 0,
      tokens: ZERO_TOKENS,
      outputBytes: utf8ByteLength(promptText),
      outputTokens: 0,
      text: promptText,
      label: promptText.replace(/\s+/g, ' ').trim() || 'User prompt',
      subtitle: 'User prompt',
      depth: 0,
    });
  }
  walkInferenceAndTool(turn.root, 0, (kind, span, depth, parentInferenceSpanId) => {
    if (kind === 'inference') {
      const requestId =
        String(span.attributes['agent_trace.inference.request_id'] ?? '') || undefined;
      const usage = readInferenceUsage(span);
      out.push({
        kind: 'inference',
        timeMs: span.startMs,
        durationMs: span.durationMs,
        tokens: inferenceTokens(span),
        outputBytes: 0,
        outputTokens: 0,
        span,
        label: inferenceLabel(span),
        subtitle: inferenceSubtitle(span),
        depth,
        requestId,
        usage,
        inferenceSpanId: span.spanId,
      });
      // Assistant text + reasoning live as events on the inference span.
      // Emit them as siblings of the inference's tool children (depth+1)
      // so the rail renderer treats them as children of *this* inference.
      // Hard-coding depth 0 made depth-1 tool rows visually nest under the
      // message instead of under the inference that emitted them.
      for (const e of span.events) {
        if (e.name === 'gen_ai.assistant.message') {
          const text = String(e.attributes?.[MESSAGE_CONTENT_ATTR] ?? '').trim();
          if (!text) continue;
          out.push({
            kind: 'assistant-message',
            timeMs: e.timeMs ?? span.startMs,
            durationMs: 0,
            tokens: ZERO_TOKENS,
            outputBytes: 0,
            outputTokens: 0,
            text,
            label: text.replace(/\s+/g, ' ').trim(),
            subtitle: 'Assistant message',
            depth: depth + 1,
            requestId,
            inferenceSpanId: span.spanId,
          });
        } else if (e.name === 'gen_ai.assistant.reasoning') {
          const text = String(e.attributes?.['gen_ai.reasoning.content'] ?? '').trim();
          out.push({
            kind: 'reasoning',
            timeMs: e.timeMs ?? span.startMs,
            durationMs: 0,
            tokens: ZERO_TOKENS,
            outputBytes: 0,
            outputTokens: 0,
            text,
            label: text ? text.replace(/\s+/g, ' ').trim() : 'Encrypted reasoning',
            subtitle: 'Reasoning',
            depth: depth + 1,
            requestId,
            usage,
            inferenceSpanId: span.spanId,
          });
        }
      }
    } else if (isPlanResponseSpan(span)) {
      out.push({
        ...buildPlanResponseStep(span, depth),
        inferenceSpanId: parentInferenceSpanId ?? undefined,
      });
    } else {
      const name = String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
      out.push({
        kind: 'tool',
        timeMs: span.startMs,
        durationMs: span.durationMs,
        tokens: ZERO_TOKENS,
        outputBytes: toolOutputBytes(span),
        outputTokens: toolOutputTokens(span),
        span,
        label: toolStepLabel(span),
        subtitle: toolStepKindLabel(name),
        depth,
        inferenceSpanId: parentInferenceSpanId ?? undefined,
      });
    }
  });
  // Fallback for the rare legacy case where assistant content sits on the
  // turn root (no owning inference). Depth 0 is correct here.
  for (const e of turn.root.events) {
    if (e.name !== 'gen_ai.assistant.message') continue;
    const text = String(e.attributes?.[MESSAGE_CONTENT_ATTR] ?? '').trim();
    if (!text) continue;
    out.push({
      kind: 'assistant-message',
      timeMs: e.timeMs ?? turn.startMs,
      durationMs: 0,
      tokens: ZERO_TOKENS,
      outputBytes: 0,
      outputTokens: 0,
      text,
      label: text.replace(/\s+/g, ' ').trim(),
      subtitle: 'Assistant message',
      depth: 0,
    });
  }
  return out;
}

function stepsForUnattached(group: UnattachedGroup): RawStep[] {
  const out: RawStep[] = [];
  walkInferenceAndTool(group.root, 0, (kind, span, depth, parentInferenceSpanId) => {
    if (kind === 'inference') {
      const requestId =
        String(span.attributes['agent_trace.inference.request_id'] ?? '') || undefined;
      out.push({
        kind: 'inference',
        timeMs: span.startMs,
        durationMs: span.durationMs,
        tokens: inferenceTokens(span),
        outputBytes: 0,
        outputTokens: 0,
        span,
        label: inferenceLabel(span),
        subtitle: inferenceSubtitle(span),
        depth,
        requestId,
        inferenceSpanId: span.spanId,
      });
    } else if (isPlanResponseSpan(span)) {
      out.push({
        ...buildPlanResponseStep(span, depth),
        inferenceSpanId: parentInferenceSpanId ?? undefined,
      });
    } else {
      const name = String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
      out.push({
        kind: 'tool',
        timeMs: span.startMs,
        durationMs: span.durationMs,
        tokens: ZERO_TOKENS,
        outputBytes: toolOutputBytes(span),
        outputTokens: toolOutputTokens(span),
        span,
        label: toolStepLabel(span),
        subtitle: toolStepKindLabel(name),
        depth,
        inferenceSpanId: parentInferenceSpanId ?? undefined,
      });
    }
  });
  return out;
}

export function buildConversationSteps(conversation: ConversationSummary): ConversationStep[] {
  const steps: ConversationStep[] = [];
  const push = (traceId: string, turnNumber: number | null, raw: RawStep, seq: number) => {
    steps.push({
      id: `${traceId}:s${seq}`,
      traceId,
      turnNumber,
      kind: raw.kind,
      variant: raw.variant,
      label: raw.label,
      subtitle: raw.subtitle,
      timeMs: raw.timeMs,
      durationMs: raw.durationMs,
      tokens: raw.tokens,
      outputBytes: raw.outputBytes,
      outputTokens: raw.outputTokens,
      span: raw.span,
      text: raw.text,
      depth: raw.depth,
      requestId: raw.requestId,
      usage: raw.usage,
      inferenceSpanId: raw.inferenceSpanId,
    });
  };
  for (const turn of conversation.turns) {
    const raws = stepsForTurn(turn);
    raws.forEach((r, i) => push(turn.traceId, turn.turnNumber, r, i));
  }
  for (const group of conversation.unattached) {
    const raws = stepsForUnattached(group);
    raws.forEach((r, i) => push(group.traceId, null, r, i));
  }
  return steps;
}

export type TrajectoryEntry =
  | { kind: 'message'; text: string; inferenceIdx: number }
  | { kind: 'reasoning'; text: string; usage: InferenceUsage; inferenceIdx: number }
  | { kind: 'tool'; span: SpanNode; inferenceIdx: number };

export interface TrajectoryInference {
  subagent: boolean;
  model: string | null;
  tokens: StepTokens;
}

export interface TrajectoryStep {
  id: string;
  index: number;
  turnNumber: number | null;
  role: 'user' | 'agent';
  model: string | null;
  entries: TrajectoryEntry[];
  inferences: TrajectoryInference[];
  preview: string;
  startMs: number;
  durationMs: number;
}

const TRAJECTORY_PREVIEW_MAX = 140;

function collapsePreview(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= TRAJECTORY_PREVIEW_MAX
    ? flat
    : `${flat.slice(0, TRAJECTORY_PREVIEW_MAX - 1)}…`;
}

function previewFromEntries(entries: TrajectoryEntry[]): string {
  for (const e of entries) {
    if (e.kind === 'message') return collapsePreview(e.text);
  }
  for (const e of entries) {
    if (e.kind === 'reasoning') {
      const body = collapsePreview(e.text);
      return body ? `thinking · ${body}` : 'thinking · encrypted';
    }
  }
  const tools = entries.filter(
    (e): e is Extract<TrajectoryEntry, { kind: 'tool' }> => e.kind === 'tool',
  );
  if (tools.length === 0) return '';
  const head =
    String(tools[0].span.attributes['agent_trace.tool.name'] ?? tools[0].span.name) || 'tool';
  const rest = tools.length - 1;
  const label = rest > 0 ? `${head} +${rest} more` : head;
  return collapsePreview(`called ${label}`);
}

/**
 * One trajectory row per user prompt, and one row per turn for the agent
 * that bundles every inference, assistant message, reasoning block, and
 * tool call (including subagent activity) the agent produced inside that
 * turn. Expanded, the row shows everything in chronological order; the
 * collapsed row surfaces the first message-or-tool preview.
 */
export function buildTrajectorySteps(conversation: ConversationSummary): TrajectoryStep[] {
  const flat = buildConversationSteps(conversation);
  const out: TrajectoryStep[] = [];
  let i = 0;
  while (i < flat.length) {
    const s = flat[i];
    if (s.kind === 'user-prompt') {
      const text = s.text ?? '';
      out.push({
        id: s.id,
        index: out.length + 1,
        turnNumber: s.turnNumber,
        role: 'user',
        model: null,
        entries: text ? [{ kind: 'message', text, inferenceIdx: 0 }] : [],
        inferences: [],
        preview: collapsePreview(text),
        startMs: s.timeMs,
        durationMs: 0,
      });
      i++;
      continue;
    }
    const traceId = s.traceId;
    const turnNumber = s.turnNumber;
    const entries: TrajectoryEntry[] = [];
    const inferences: TrajectoryInference[] = [];
    let firstModel: string | null = null;
    const startMs = s.timeMs;
    let endMs = s.timeMs + s.durationMs;
    let inferenceIdx = -1;
    // Map each inference's spanId to the index it occupies in `inferences[]`.
    // This lets a tool/message/reasoning entry resolve its OWN emitting
    // inference rather than picking up whatever inference was most recently
    // seen in flat order — which was wrong whenever a sibling tool followed
    // a subagent's nested inferences (e.g. parallel Agent dispatches).
    const idxBySpanId = new Map<string, number>();
    let j = i;
    while (j < flat.length) {
      const c = flat[j];
      if (c.kind === 'user-prompt') break;
      if (c.traceId !== traceId) break;
      if (c.turnNumber !== turnNumber) break;
      endMs = Math.max(endMs, c.timeMs + c.durationMs);
      if (c.kind === 'inference') {
        inferenceIdx++;
        const m = c.span?.attributes['gen_ai.request.model'];
        const model = typeof m === 'string' && m ? m : null;
        inferences.push({ subagent: c.depth > 0, model, tokens: c.tokens });
        if (c.inferenceSpanId) idxBySpanId.set(c.inferenceSpanId, inferenceIdx);
        if (firstModel === null && model) firstModel = model;
      } else {
        // Resolution rules:
        // - spanId set + found  → owning inference (the correct answer).
        // - spanId absent       → no structural parent recorded (legacy
        //   fallback messages on the turn root). Fall back to most-recent.
        // - spanId set + missed → impossible by construction; if it ever
        //   happens, leave inferenceIdx at -1 so the downstream lookup
        //   `inferences[-1]` returns undefined rather than silently
        //   misattributing to inference 0.
        const resolvedIdx = c.inferenceSpanId
          ? (idxBySpanId.get(c.inferenceSpanId) ?? -1)
          : inferenceIdx;
        if (c.kind === 'assistant-message' && c.text) {
          entries.push({ kind: 'message', text: c.text, inferenceIdx: resolvedIdx });
        } else if (c.kind === 'reasoning') {
          entries.push({
            kind: 'reasoning',
            text: c.text ?? '',
            usage: c.usage ?? ZERO_USAGE,
            inferenceIdx: resolvedIdx,
          });
        } else if (c.kind === 'tool' && c.span) {
          entries.push({ kind: 'tool', span: c.span, inferenceIdx: resolvedIdx });
        }
      }
      j++;
    }
    if (inferences.length === 0 && entries.length > 0) {
      inferences.push({ subagent: false, model: null, tokens: ZERO_TOKENS });
    }
    out.push({
      id: s.id,
      index: out.length + 1,
      turnNumber,
      role: 'agent',
      model: firstModel,
      entries,
      inferences,
      preview: previewFromEntries(entries),
      startMs,
      durationMs: Math.max(0, endMs - startMs),
    });
    i = j > i ? j : i + 1;
  }
  return out;
}

export interface InferenceUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export type TurnTimelineEntry =
  | { kind: 'tool'; timeMs: number; span: SpanNode }
  | { kind: 'message'; timeMs: number; text: string; usage: InferenceUsage }
  | { kind: 'reasoning'; timeMs: number; text: string };

const ZERO_USAGE: InferenceUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
};

function readInferenceUsage(span: SpanNode): InferenceUsage {
  const a = span.attributes;
  return {
    inputTokens: Number(a?.['gen_ai.usage.input_tokens'] ?? 0),
    cacheReadTokens: Number(a?.['gen_ai.usage.cache_read_tokens'] ?? 0),
    cacheCreationTokens: Number(a?.['gen_ai.usage.cache_creation_tokens'] ?? 0),
    outputTokens: Number(a?.['gen_ai.usage.output_tokens'] ?? 0),
  };
}

/**
 * Build a chronological list of everything that happened inside a turn —
 * tool calls, assistant messages, reasoning — so the UI can render a chat
 * shape with tool waterfalls and assistant output interleaved.
 *
 * The `end_turn` message also renders as the always-visible bookend on the
 * turn row, but we include it here too so the expanded event list is a
 * faithful chronological record.
 *
 * Each `message` entry is stamped with the four token counts of the
 * inference span that emitted it, so the UI can surface per-inference cost
 * alongside the text. Messages emitted directly on the turn root (legacy
 * fallback, no inference parent) report zero usage.
 */
export function buildTurnTimeline(turn: SpanNode): TurnTimelineEntry[] {
  const entries: TurnTimelineEntry[] = [];

  // Legacy fallback: assistant-content events on the turn root itself have
  // no associated inference span, so usage is unknown (zero).
  for (const e of turn.events) {
    if (e.name === 'gen_ai.assistant.message') {
      const text = messageTextOf(e);
      if (text) {
        entries.push({
          kind: 'message',
          timeMs: e.timeMs ?? turn.startMs,
          text,
          usage: ZERO_USAGE,
        });
      }
    } else if (e.name === 'gen_ai.assistant.reasoning') {
      const text = String(e.attributes?.['gen_ai.reasoning.content'] ?? '');
      entries.push({
        kind: 'reasoning',
        timeMs: e.timeMs ?? turn.startMs,
        text,
      });
    }
  }

  // Walk turn children. Tool spans nest under their emitting inference; we
  // flatten them up to the timeline level so the chat shape preserves the
  // previous "tool calls inline with messages" layout. Slash turns and orphan
  // reparenting fallbacks still surface tool spans as direct turn children.
  for (const child of turn.children) {
    if (child.name === 'inference') {
      const usage = readInferenceUsage(child);
      for (const grand of child.children) {
        entries.push({ kind: 'tool', timeMs: grand.startMs, span: grand });
      }
      for (const e of child.events) {
        if (e.name === 'gen_ai.assistant.message') {
          const text = messageTextOf(e);
          if (text) {
            entries.push({
              kind: 'message',
              timeMs: e.timeMs ?? turn.startMs,
              text,
              usage,
            });
          }
        } else if (e.name === 'gen_ai.assistant.reasoning') {
          const text = String(e.attributes?.['gen_ai.reasoning.content'] ?? '');
          entries.push({
            kind: 'reasoning',
            timeMs: e.timeMs ?? turn.startMs,
            text,
          });
        }
      }
    } else {
      entries.push({ kind: 'tool', timeMs: child.startMs, span: child });
    }
  }

  entries.sort((a, b) => a.timeMs - b.timeMs);
  return entries;
}

import { extractSlashCommand, stripLocalCommandCaveat } from '@/lib/utils';
import type {
  ConversationSummary,
  SpanNode,
  Turn,
  UnattachedGroup,
} from '@/types';

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
  const structural =
    Boolean(n.attributes?.['agent_trace.event_type']) ||
    n.name === 'inference';
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

function latestMessageWithStop(
  events: SpanNode['events'],
  stop: string,
): { text: string } | null {
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
  const events = turn.root.events;
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

export function collectUnattached(
  conversation: ConversationSummary,
): UnattachedEntry[] {
  return conversation.unattached.map(buildUnattachedEntry);
}

export type ConversationStepKind =
  | 'user-prompt'
  | 'inference'
  | 'tool'
  | 'assistant-message';

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

export interface ConversationStep {
  id: string;
  traceId: string;
  turnNumber: number | null;
  kind: ConversationStepKind;
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
    cacheCreation: Number(
      span.attributes['gen_ai.usage.cache_creation_tokens'] ?? 0,
    ),
    output: Number(span.attributes['gen_ai.usage.output_tokens'] ?? 0),
  };
}

function toolStepKindLabel(name: string): string {
  if (TOOL_KIND_LABEL[name]) return TOOL_KIND_LABEL[name];
  if (name.startsWith('mcp__')) return 'MCP tool';
  return 'Tool';
}

function toolStepLabel(span: SpanNode): string {
  const name =
    String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function isStructuralSpan(span: SpanNode): boolean {
  return (
    Boolean(span.attributes['agent_trace.event_type']) ||
    span.name === 'inference'
  );
}

function walkInferenceAndTool(
  span: SpanNode,
  depth: number,
  emit: (step: 'inference' | 'tool', span: SpanNode, depth: number) => void,
): void {
  if (span.name === 'inference') {
    emit('inference', span, depth);
    return;
  }
  if (!isStructuralSpan(span)) {
    emit('tool', span, depth);
  }
  // A `subagent:<type>` span is structural and not emitted itself, but its
  // children (the tools/inferences run by the subagent) belong one level
  // deeper so the UI can indent them under their parent Agent dispatch.
  const childDepth =
    span.attributes['agent_trace.event_type'] === 'subagent' ? depth + 1 : depth;
  for (const child of span.children) walkInferenceAndTool(child, childDepth, emit);
}

interface RawStep {
  kind: ConversationStepKind;
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

function stepsForTurn(turn: Turn): RawStep[] {
  const out: RawStep[] = [];
  const promptText = (() => {
    const raw = turn.userPrompt;
    const stripped =
      turn.turnNumber === 1 ? stripLocalCommandCaveat(raw) : raw.trim();
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
  walkInferenceAndTool(turn.root, 0, (kind, span, depth) => {
    if (kind === 'inference') {
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
      });
    } else {
      const name =
        String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
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
      });
    }
  });
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
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

function stepsForUnattached(group: UnattachedGroup): RawStep[] {
  const out: RawStep[] = [];
  walkInferenceAndTool(group.root, 0, (kind, span, depth) => {
    if (kind === 'inference') {
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
      });
    } else {
      const name =
        String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
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
      });
    }
  });
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

export function buildConversationSteps(
  conversation: ConversationSummary,
): ConversationStep[] {
  const steps: ConversationStep[] = [];
  const push = (
    traceId: string,
    turnNumber: number | null,
    raw: RawStep,
    seq: number,
  ) => {
    steps.push({
      id: `${traceId}:s${seq}`,
      traceId,
      turnNumber,
      kind: raw.kind,
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

export type TurnTimelineEntry =
  | { kind: 'tool'; timeMs: number; span: SpanNode }
  | { kind: 'message'; timeMs: number; text: string }
  | { kind: 'reasoning'; timeMs: number; text: string };

/**
 * Build a chronological list of everything that happened inside a turn —
 * tool calls, assistant messages, reasoning — so the UI can render a chat
 * shape with tool waterfalls and assistant output interleaved.
 *
 * The `end_turn` message also renders as the always-visible bookend on the
 * turn row, but we include it here too so the expanded event list is a
 * faithful chronological record.
 */
export function buildTurnTimeline(turn: SpanNode): TurnTimelineEntry[] {
  const entries: TurnTimelineEntry[] = [
    ...turn.children.map(
      (span): TurnTimelineEntry => ({
        kind: 'tool',
        timeMs: span.startMs,
        span,
      }),
    ),
    ...turn.events.flatMap((e): TurnTimelineEntry[] => {
      if (e.name === 'gen_ai.assistant.message') {
        const text = messageTextOf(e);
        return text
          ? [{ kind: 'message', timeMs: e.timeMs ?? turn.startMs, text }]
          : [];
      }
      if (e.name === 'gen_ai.assistant.reasoning') {
        const text = String(e.attributes?.['gen_ai.reasoning.content'] ?? '');
        return text
          ? [{ kind: 'reasoning', timeMs: e.timeMs ?? turn.startMs, text }]
          : [];
      }
      return [];
    }),
  ];
  entries.sort((a, b) => a.timeMs - b.timeMs);
  return entries;
}

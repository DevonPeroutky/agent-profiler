import type {
  ConversationSummary,
  SpanNode,
  Turn,
  UnattachedGroup,
} from '@/types';

export interface InferenceTokens {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export type ContentKind = 'thinking' | 'text' | 'tool_use';

export interface Dispatch {
  dispatchToolSpan: SpanNode;
  toolName: string;
  subagentType: string | null;
  description: string | null;
  childBranchId: string;
  subagentTokens: InferenceTokens;
  requestCount: number;
}

export interface InferenceNode {
  id: string;
  branchId: string;
  parentNodeId: string | null;
  depth: number;
  ordinal: number;
  turnNumber: number | null;
  requestId: string | null;
  model: string | null;
  stopReason: string | null;
  has: Record<ContentKind, boolean>;
  tokens: InferenceTokens;
  durationMs: number;
  precedingTools: SpanNode[];
  emittedTools: SpanNode[];
  dispatches: Dispatch[];
  span: SpanNode;
  isSynthetic: boolean;
  syntheticLabel: string | null;
  isUnattached: boolean;
}

export interface SubagentTotals {
  type: string;
  tokens: InferenceTokens;
  count: number;
}

export interface InferenceFlowModel {
  conversationTotals: InferenceTokens;
  perSubagentTotals: SubagentTotals[];
  branches: Map<string, InferenceNode[]>;
  rootBranchId: 'main';
  unattachedBranchIds: string[];
}

const ZERO_TOKENS: InferenceTokens = {
  input: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function skillFromToolInput(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      obj !== null &&
      typeof obj === 'object' &&
      'skill' in obj &&
      typeof (obj as { skill: unknown }).skill === 'string'
    ) {
      const s = (obj as { skill: string }).skill.trim();
      return s || null;
    }
  } catch {
    /* not JSON; fall through */
  }
  return null;
}

function deriveDispatchType(
  toolName: string,
  dt: SpanNode,
  subagentSpan: SpanNode,
): string | null {
  if (toolName === 'Skill') {
    const input = asString(dt.attributes['agent_trace.tool.input_summary']);
    const skill = skillFromToolInput(input);
    if (skill) return skill;
    const slash = asString(dt.attributes['agent_trace.tool.slash_command']);
    if (slash) return `/${slash}`;
  }
  return (
    asString(dt.attributes['agent_trace.subagent.type']) ??
    asString(subagentSpan.attributes['agent_trace.subagent.type'])
  );
}

function readInferenceTokens(span: SpanNode): InferenceTokens {
  return {
    input: Number(span.attributes['gen_ai.usage.input_tokens'] ?? 0),
    cacheRead: Number(span.attributes['gen_ai.usage.cache_read_tokens'] ?? 0),
    cacheCreation: Number(
      span.attributes['gen_ai.usage.cache_creation_tokens'] ?? 0,
    ),
    output: Number(span.attributes['gen_ai.usage.output_tokens'] ?? 0),
  };
}

function readSubagentTokens(span: SpanNode): InferenceTokens {
  return {
    input: Number(span.attributes['agent_trace.subagent.input_tokens'] ?? 0),
    cacheRead: Number(
      span.attributes['agent_trace.subagent.cache_read_tokens'] ?? 0,
    ),
    cacheCreation: Number(
      span.attributes['agent_trace.subagent.cache_creation_tokens'] ?? 0,
    ),
    output: Number(span.attributes['agent_trace.subagent.output_tokens'] ?? 0),
  };
}

// A tool span that dispatches a subagent has exactly one structural
// `subagent:<type>` child (event_type === 'subagent'). Detection is
// structural — never timestamp- or name-pattern-based — per CLAUDE.md §2.
function findSubagentChild(span: SpanNode): SpanNode | null {
  for (const c of span.children) {
    if (c.attributes?.['agent_trace.event_type'] === 'subagent') return c;
  }
  return null;
}

function categorizeInferenceChildren(inf: SpanNode): {
  dispatchSpans: SpanNode[];
  emittedTools: SpanNode[];
} {
  const dispatchSpans: SpanNode[] = [];
  const emittedTools: SpanNode[] = [];
  for (const child of inf.children) {
    if (findSubagentChild(child)) dispatchSpans.push(child);
    else emittedTools.push(child);
  }
  return { dispatchSpans, emittedTools };
}

interface BuildContext {
  branches: Map<string, InferenceNode[]>;
  unattachedBranchIds: string[];
}

function pushNode(
  ctx: BuildContext,
  branchId: string,
  build: (ordinal: number) => InferenceNode,
): InferenceNode {
  const list = ctx.branches.get(branchId);
  if (!list) {
    const created: InferenceNode[] = [];
    ctx.branches.set(branchId, created);
    const node = build(1);
    created.push(node);
    return node;
  }
  const node = build(list.length + 1);
  list.push(node);
  return node;
}

function buildInferenceNode(
  inf: SpanNode,
  branchId: string,
  parentNodeId: string | null,
  depth: number,
  turnNumber: number | null,
  ordinal: number,
  ctx: BuildContext,
  isUnattached: boolean,
): InferenceNode {
  const { dispatchSpans, emittedTools } = categorizeInferenceChildren(inf);
  const dispatches: Dispatch[] = [];

  for (const dt of dispatchSpans) {
    const subagentSpan = findSubagentChild(dt);
    if (!subagentSpan) continue;
    const childBranchId = `${inf.spanId}:${dt.spanId}`;
    ctx.branches.set(childBranchId, []);
    walkSubagentChildren(
      subagentSpan,
      childBranchId,
      inf.spanId,
      depth + 1,
      turnNumber,
      ctx,
      isUnattached,
    );
    const toolName = asString(dt.attributes['agent_trace.tool.name']) ?? dt.name;
    const subagentType = deriveDispatchType(toolName, dt, subagentSpan);
    const description =
      asString(dt.attributes['agent_trace.subagent.description']) ??
      asString(subagentSpan.attributes['agent_trace.subagent.description']);
    const requestCount = Number(
      subagentSpan.attributes['agent_trace.subagent.request_count'] ?? 0,
    );
    dispatches.push({
      dispatchToolSpan: dt,
      toolName,
      subagentType,
      description,
      childBranchId,
      subagentTokens: readSubagentTokens(dt),
      requestCount: Number.isFinite(requestCount) ? requestCount : 0,
    });
  }

  return {
    id: inf.spanId,
    branchId,
    parentNodeId,
    depth,
    ordinal,
    turnNumber,
    requestId: asString(inf.attributes['agent_trace.inference.request_id']),
    model: asString(inf.attributes['gen_ai.request.model']),
    stopReason:
      asString(inf.attributes['agent_trace.response.stop_reason']) ??
      asString(inf.attributes['agent_trace.inference.stop_reason']),
    has: {
      thinking: Boolean(inf.attributes['agent_trace.inference.has_thinking']),
      text: Boolean(inf.attributes['agent_trace.inference.has_text']),
      tool_use: Boolean(inf.attributes['agent_trace.inference.has_tool_use']),
    },
    tokens: readInferenceTokens(inf),
    durationMs: inf.durationMs,
    precedingTools: [],
    emittedTools,
    dispatches,
    span: inf,
    isSynthetic: false,
    syntheticLabel: null,
    isUnattached,
  };
}

// Walk a subagent or unattached group: its direct children are inference
// spans (the subagent's API calls). Sometimes the structure nests another
// subagent_group inside; recurse transparently in that case.
function walkSubagentChildren(
  parent: SpanNode,
  branchId: string,
  parentNodeId: string | null,
  depth: number,
  turnNumber: number | null,
  ctx: BuildContext,
  isUnattached: boolean,
): void {
  for (const child of parent.children) {
    if (child.name === 'inference') {
      pushNode(ctx, branchId, (ordinal) =>
        buildInferenceNode(
          child,
          branchId,
          parentNodeId,
          depth,
          turnNumber,
          ordinal,
          ctx,
          isUnattached,
        ),
      );
      continue;
    }
    const eventType = child.attributes?.['agent_trace.event_type'];
    if (eventType === 'subagent' || eventType === 'subagent_group') {
      walkSubagentChildren(
        child,
        branchId,
        parentNodeId,
        depth,
        turnNumber,
        ctx,
        isUnattached,
      );
    }
    // Tool spans at this level (no enclosing inference) are unusual; ignore
    // — they don't fit the "inferences as nodes" model.
  }
}

function syntheticLabelFor(turn: Turn): string {
  const raw = (turn.userPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (raw.startsWith('/')) return raw.split(' ')[0];
  if (raw) return raw.length > 32 ? raw.slice(0, 31) + '…' : raw;
  return '(no prompt)';
}

function makeSyntheticNode(turn: Turn, ordinal: number): InferenceNode {
  return {
    id: `synth:${turn.traceId}`,
    branchId: 'main',
    parentNodeId: null,
    depth: 0,
    ordinal,
    turnNumber: turn.turnNumber,
    requestId: null,
    model: null,
    stopReason: null,
    has: { thinking: false, text: false, tool_use: false },
    tokens: { ...ZERO_TOKENS },
    durationMs: 0,
    precedingTools: [],
    emittedTools: [],
    dispatches: [],
    span: turn.root,
    isSynthetic: true,
    syntheticLabel: syntheticLabelFor(turn),
    isUnattached: false,
  };
}

function walkTurn(turn: Turn, ctx: BuildContext): void {
  let synthetic: InferenceNode | null = null;
  for (const child of turn.root.children) {
    if (child.name === 'inference') {
      pushNode(ctx, 'main', (ordinal) =>
        buildInferenceNode(
          child,
          'main',
          null,
          0,
          turn.turnNumber,
          ordinal,
          ctx,
          false,
        ),
      );
      continue;
    }
    // Hooks and other structural spans on the turn root: skip.
    if (child.attributes?.['agent_trace.event_type']) continue;
    // Top-level tool span that dispatches a subagent without a parent
    // inference (the slash-command Skill triad). Anchor under a synthetic
    // node so the spur has a parent on the rail.
    const subagentChild = findSubagentChild(child);
    if (!subagentChild) continue;
    if (!synthetic) {
      const list = ctx.branches.get('main')!;
      synthetic = makeSyntheticNode(turn, list.length + 1);
      list.push(synthetic);
    }
    const childBranchId = `${synthetic.id}:${child.spanId}`;
    ctx.branches.set(childBranchId, []);
    walkSubagentChildren(
      subagentChild,
      childBranchId,
      synthetic.id,
      1,
      turn.turnNumber,
      ctx,
      false,
    );
    const requestCount = Number(
      subagentChild.attributes['agent_trace.subagent.request_count'] ?? 0,
    );
    const toolName =
      asString(child.attributes['agent_trace.tool.name']) ?? child.name;
    synthetic.dispatches.push({
      dispatchToolSpan: child,
      toolName,
      subagentType: deriveDispatchType(toolName, child, subagentChild),
      description:
        asString(child.attributes['agent_trace.subagent.description']) ??
        asString(subagentChild.attributes['agent_trace.subagent.description']),
      childBranchId,
      subagentTokens: readSubagentTokens(child),
      requestCount: Number.isFinite(requestCount) ? requestCount : 0,
    });
  }
}

function walkUnattached(
  group: UnattachedGroup,
  index: number,
  ctx: BuildContext,
): void {
  const branchId = `unattached:${index}`;
  ctx.branches.set(branchId, []);
  ctx.unattachedBranchIds.push(branchId);
  walkSubagentChildren(group.root, branchId, null, 0, null, ctx, true);
}

function fillPrecedingTools(branches: Map<string, InferenceNode[]>): void {
  for (const nodes of branches.values()) {
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      // emittedTools already excludes dispatch spans by construction, so this
      // is just "what the previous inference asked the harness to run."
      nodes[i].precedingTools = prev.emittedTools;
    }
  }
}

function aggregateSubagentTotals(
  branches: Map<string, InferenceNode[]>,
): SubagentTotals[] {
  const byType = new Map<string, { tokens: InferenceTokens; count: number }>();
  for (const nodes of branches.values()) {
    for (const node of nodes) {
      for (const d of node.dispatches) {
        const type = d.subagentType ?? '(unknown)';
        const slot = byType.get(type) ?? {
          tokens: { ...ZERO_TOKENS },
          count: 0,
        };
        slot.tokens.input += d.subagentTokens.input;
        slot.tokens.cacheRead += d.subagentTokens.cacheRead;
        slot.tokens.cacheCreation += d.subagentTokens.cacheCreation;
        slot.tokens.output += d.subagentTokens.output;
        slot.count += 1;
        byType.set(type, slot);
      }
    }
  }
  return Array.from(byType.entries())
    .map(([type, v]) => ({ type, tokens: v.tokens, count: v.count }))
    .sort(
      (a, b) =>
        b.tokens.input +
        b.tokens.cacheRead +
        b.tokens.cacheCreation +
        b.tokens.output -
        (a.tokens.input +
          a.tokens.cacheRead +
          a.tokens.cacheCreation +
          a.tokens.output),
    );
}

function conversationTotals(turns: readonly Turn[]): InferenceTokens {
  const t: InferenceTokens = { ...ZERO_TOKENS };
  for (const turn of turns) {
    t.input += turn.contextTokens.input;
    t.cacheRead += turn.contextTokens.cacheRead;
    t.cacheCreation += turn.contextTokens.cacheCreation;
    t.output += turn.contextTokens.output;
  }
  return t;
}

export function buildInferenceFlowModel(
  conversation: ConversationSummary,
): InferenceFlowModel {
  const ctx: BuildContext = {
    branches: new Map([['main', []]]),
    unattachedBranchIds: [],
  };
  for (const turn of conversation.turns) walkTurn(turn, ctx);
  conversation.unattached.forEach((g, i) => walkUnattached(g, i, ctx));
  fillPrecedingTools(ctx.branches);
  return {
    conversationTotals: conversationTotals(conversation.turns),
    perSubagentTotals: aggregateSubagentTotals(ctx.branches),
    branches: ctx.branches,
    rootBranchId: 'main',
    unattachedBranchIds: ctx.unattachedBranchIds,
  };
}

export function totalTokens(t: InferenceTokens): number {
  return t.input + t.cacheRead + t.cacheCreation + t.output;
}

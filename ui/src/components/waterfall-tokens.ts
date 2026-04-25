import type { SpanNode } from '@/types';

export const TOKEN_CATS = {
  fresh:      { label: 'Fresh input', cls: 'bg-[var(--tok-fresh)]' },
  cacheRead:  { label: 'Cache read',  cls: 'bg-[var(--tok-cache-read)]' },
  cacheWrite: { label: 'Cache write', cls: 'bg-[var(--tok-cache-write)]' },
  output:     { label: 'Output',      cls: 'bg-[var(--tok-output)]' },
} as const;

export const TOKEN_CAT_ORDER = ['fresh', 'cacheRead', 'cacheWrite', 'output'] as const;
export type TokenCat = typeof TOKEN_CAT_ORDER[number];

export interface Tokens { fresh: number; cacheRead: number; cacheWrite: number; output: number; }
const ZERO: Tokens = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function readNum(attrs: Record<string, unknown>, key: string): number {
  const n = Number(attrs[key]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Attribution rules:
// 1. Inference spans carry gen_ai.usage.* — count directly, but dedupe by
//    request_id across the visible row list (continuation rows of the same
//    request carry the same usage blob per CLAUDE.md).
// 2. Subagent roots carry agent_trace.subagent.*_tokens — only count when the
//    row is collapsed && has children (descendants hidden, aggregate fills in).
// 3. Everything else (tools, hooks, Skill, task:, compact, turn:) — zero.
function tokensOfSpan(
  span: SpanNode,
  useAggregate: boolean,
  seenRequestIds: Set<string>,
): Tokens {
  const a = span.attributes;
  if ('gen_ai.usage.input_tokens' in a || 'gen_ai.usage.output_tokens' in a) {
    const rid = String(a['agent_trace.inference.request_id'] ?? '');
    if (rid && seenRequestIds.has(rid)) return ZERO;
    if (rid) seenRequestIds.add(rid);
    return {
      fresh:      readNum(a, 'gen_ai.usage.input_tokens'),
      cacheRead:  readNum(a, 'gen_ai.usage.cache_read_tokens'),
      cacheWrite: readNum(a, 'gen_ai.usage.cache_creation_tokens'),
      output:     readNum(a, 'gen_ai.usage.output_tokens'),
    };
  }
  if (useAggregate && 'agent_trace.subagent.input_tokens' in a) {
    return {
      fresh:      readNum(a, 'agent_trace.subagent.input_tokens'),
      cacheRead:  readNum(a, 'agent_trace.subagent.cache_read_tokens'),
      cacheWrite: readNum(a, 'agent_trace.subagent.cache_creation_tokens'),
      output:     readNum(a, 'agent_trace.subagent.output_tokens'),
    };
  }
  return ZERO;
}

function tokenSum(t: Tokens): number {
  return t.fresh + t.cacheRead + t.cacheWrite + t.output;
}

export interface TokenBar {
  prevPct: number;
  deltaPct: number;
  delta: number;
  segments: Array<{ cls: string; widthPct: number }>;
}

export interface TokenRowInput {
  span: SpanNode;
  hasChildren: boolean;
}

export function computeTokenBars(
  rows: ReadonlyArray<TokenRowInput>,
  collapsed: ReadonlySet<string>,
): TokenBar[] {
  const seenRequestIds = new Set<string>();
  const perRow = rows.map(({ span, hasChildren }) => {
    const isCollapsedWithKids = collapsed.has(span.spanId) && hasChildren;
    const tokens = tokensOfSpan(span, isCollapsedWithKids, seenRequestIds);
    return { tokens, delta: tokenSum(tokens) };
  });

  let cum = 0;
  const prevs = perRow.map(({ delta }) => {
    const prev = cum;
    cum += delta;
    return prev;
  });
  const total = cum || 1;

  return perRow.map(({ tokens, delta }, i) => {
    const prev = prevs[i];
    const prevPct = (prev / total) * 100;
    const deltaPct = (delta / total) * 100;
    const segments =
      delta > 0
        ? TOKEN_CAT_ORDER.flatMap((k) =>
            tokens[k] > 0
              ? [{ cls: TOKEN_CATS[k].cls, widthPct: (tokens[k] / delta) * 100 }]
              : [],
          )
        : [];
    return { prevPct, deltaPct, delta, segments };
  });
}

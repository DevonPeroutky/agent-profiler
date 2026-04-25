import type { SpanNode, TraceSummary } from '@/types';

// Spans with these names are removed from the tree before render.
// Add names here to hide additional hooks/tools/subagents from the waterfall.
export const HIDDEN_SPAN_NAMES: ReadonlySet<string> = new Set([
  'hook:Stop',
]);

// Events with these names are removed from each span's events[] before render.
export const HIDDEN_EVENT_NAMES: ReadonlySet<string> = new Set();

function filterSpan(span: SpanNode): SpanNode {
  return {
    ...span,
    events: span.events.filter((e) => !HIDDEN_EVENT_NAMES.has(e.name)),
    children: span.children
      .filter((c) => !HIDDEN_SPAN_NAMES.has(c.name))
      .map(filterSpan),
  };
}

export function filterTraces(traces: TraceSummary[]): TraceSummary[] {
  return traces.map((t) => ({ ...t, root: filterSpan(t.root) }));
}

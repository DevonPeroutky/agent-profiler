import type { SpanNode, Turn } from '@/types';

export const MAIN_OWNER_KEY = '__main__';
export const MAIN_OWNER_LABEL = 'Main';

export const MAIN_COLOR = '#2563eb';
export const SUBAGENT_PALETTE = [
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#ef4444',
  '#f97316',
  '#0ea5e9',
];

export interface OwnerInfo {
  key: string;
  label: string;
  kind: 'main' | 'subagent';
  toolName: string | null;
  color: string;
}

export const MAIN_OWNER: OwnerInfo = {
  key: MAIN_OWNER_KEY,
  label: MAIN_OWNER_LABEL,
  kind: 'main',
  toolName: null,
  color: MAIN_COLOR,
};

export interface OwnerRegistry {
  resolve(node: SpanNode, parent: SpanNode | null): OwnerInfo;
}

export function extractSkillName(parent: SpanNode): string | null {
  const summary = parent.attributes['agent_trace.tool.input_summary'];
  if (typeof summary === 'string' && summary.length > 0) {
    try {
      const parsed = JSON.parse(summary) as { skill?: unknown };
      if (typeof parsed.skill === 'string' && parsed.skill.length > 0) {
        return parsed.skill;
      }
    } catch {
      // input_summary is opportunistically truncated; tolerate non-JSON
    }
  }
  // Slash-command synthetic Skill spans carry no JSON `skill` payload — the
  // command name lives on `agent_trace.tool.slash_command`. Always check it,
  // even when input_summary is empty (e.g. `/clear` with no args).
  const slash = parent.attributes['agent_trace.tool.slash_command'];
  if (typeof slash === 'string' && slash.length > 0) return `/${slash}`;
  return null;
}

export function createOwnerRegistry(): OwnerRegistry {
  const byId = new Map<string, OwnerInfo>();
  const dispatchCountsByType = new Map<string, number>();
  let paletteCursor = 0;

  return {
    resolve(node, parent) {
      const attrs = node.attributes;
      const id =
        typeof attrs['agent_trace.subagent.id'] === 'string'
          ? (attrs['agent_trace.subagent.id'] as string)
          : node.spanId;
      const cached = byId.get(id);
      if (cached) return cached;

      const toolName =
        parent && typeof parent.attributes['agent_trace.tool.name'] === 'string'
          ? (parent.attributes['agent_trace.tool.name'] as string)
          : null;

      const subagentType =
        typeof attrs['agent_trace.subagent.type'] === 'string'
          ? (attrs['agent_trace.subagent.type'] as string)
          : node.name.replace(/^subagent:/, '') || 'subagent';
      let type = subagentType;
      if (toolName === 'Skill' && parent) {
        const skillFromParent = extractSkillName(parent);
        if (skillFromParent) type = skillFromParent;
      }
      const next = (dispatchCountsByType.get(type) ?? 0) + 1;
      dispatchCountsByType.set(type, next);

      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const color = SUBAGENT_PALETTE[paletteCursor % SUBAGENT_PALETTE.length];
      paletteCursor += 1;
      const info: OwnerInfo = {
        key: `sub_${safeId}`,
        label: type,
        kind: 'subagent',
        toolName,
        color,
      };
      byId.set(id, info);
      (info as OwnerInfo & { __type: string; __index: number }).__type = type;
      (info as OwnerInfo & { __type: string; __index: number }).__index = next;
      return info;
    },
  };
}

export function finalizeOwnerLabels(owners: OwnerInfo[]) {
  const totals = new Map<string, number>();
  for (const o of owners) {
    if (o.kind !== 'subagent') continue;
    const t = (o as OwnerInfo & { __type?: string }).__type;
    if (!t) continue;
    totals.set(t, (totals.get(t) ?? 0) + 1);
  }
  for (const o of owners) {
    if (o.kind !== 'subagent') continue;
    const meta = o as OwnerInfo & { __type?: string; __index?: number };
    if (!meta.__type || meta.__index == null) continue;
    if ((totals.get(meta.__type) ?? 0) > 1) {
      o.label = `${meta.__type} #${meta.__index}`;
    } else {
      o.label = meta.__type;
    }
  }
}

export interface FlatOwnedSpan<TurnNumber = number | null> {
  node: SpanNode;
  parent: SpanNode | null;
  turnNumber: TurnNumber;
  startMs: number;
  endMs: number;
  owner: OwnerInfo;
}

/**
 * Walk a turn (or any subtree rooted at a span) and emit every descendant
 * span paired with its current owner. The owner flips to a fresh subagent
 * `OwnerInfo` whenever a `subagent:*` span is entered, and reverts on the
 * way out by virtue of recursion. New owners are appended to `ownersSeen`
 * in first-encountered order.
 */
export function flattenOwnedSpans<T extends number | null>(
  root: SpanNode,
  turnNumber: T,
  registry: OwnerRegistry,
  ownersSeen: OwnerInfo[],
): FlatOwnedSpan<T>[] {
  const out: FlatOwnedSpan<T>[] = [];
  const visit = (node: SpanNode, parent: SpanNode | null, owner: OwnerInfo) => {
    let nextOwner = owner;
    if (node.name.startsWith('subagent:')) {
      nextOwner = registry.resolve(node, parent);
      if (!ownersSeen.includes(nextOwner)) ownersSeen.push(nextOwner);
    }
    out.push({
      node,
      parent,
      turnNumber,
      startMs: node.startMs,
      endMs: node.endMs,
      owner: nextOwner,
    });
    for (const child of node.children) visit(child, node, nextOwner);
  };
  for (const child of root.children) visit(child, root, MAIN_OWNER);
  return out;
}

export function flattenOwnedSpansForTurn(
  turn: Turn,
  registry: OwnerRegistry,
  ownersSeen: OwnerInfo[],
): FlatOwnedSpan<number>[] {
  return flattenOwnedSpans(turn.root, turn.turnNumber, registry, ownersSeen);
}

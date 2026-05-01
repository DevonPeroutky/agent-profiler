import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import type { ConversationSummary, SpanNode, Turn } from '@/types';
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ui/chart';
import { SectionCard } from '@/components/ui/section-card';
import { ChartTooltipShell } from '@/components/ui/chart-tooltip-shell';
import { fmt } from './format';

interface PrecedingAction {
  name: string;
  outputChars: number;
}

const MAIN_OWNER_KEY = '__main__';
const MAIN_OWNER_LABEL = 'Main';

const MAIN_COLOR = '#2563eb';
const SUBAGENT_PALETTE = [
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#ef4444',
  '#f97316',
  '#0ea5e9',
];

interface OwnerInfo {
  key: string;
  label: string;
  kind: 'main' | 'subagent';
  toolName: string | null;
  color: string;
}

interface Row {
  index: number;
  turnNumber: number;
  label: string;
  turnLabel: string;
  inferenceLabel: string;
  cacheRead: number;
  cacheCreation: number;
  freshInput: number;
  total: number;
  ownerKey: string;
  ownerLabel: string;
  ownerKind: 'main' | 'subagent';
  ownerToolName: string | null;
  ownerColor: string;
  model: string | null;
  trigger: string;
  precedingActions: PrecedingAction[];
  isTurnStart: boolean;
}

interface ChartFlatSpan {
  node: SpanNode;
  turnNumber: number;
  startMs: number;
  endMs: number;
  owner: OwnerInfo;
}

const MAIN_OWNER: OwnerInfo = {
  key: MAIN_OWNER_KEY,
  label: MAIN_OWNER_LABEL,
  kind: 'main',
  toolName: null,
  color: MAIN_COLOR,
};

interface OwnerRegistry {
  // resolves a subagent span to a stable OwnerInfo, assigning per-type indices
  resolve(node: SpanNode, parent: SpanNode | null): OwnerInfo;
}

function extractSkillName(parent: SpanNode): string | null {
  const summary = parent.attributes['agent_trace.tool.input_summary'];
  if (typeof summary !== 'string' || summary.length === 0) return null;
  try {
    const parsed = JSON.parse(summary) as { skill?: unknown };
    if (typeof parsed.skill === 'string' && parsed.skill.length > 0) {
      return parsed.skill;
    }
  } catch {
    // input_summary is opportunistically truncated; tolerate non-JSON
  }
  const slash = parent.attributes['agent_trace.tool.slash_command'];
  if (typeof slash === 'string' && slash.length > 0) return `/${slash}`;
  return null;
}

function createOwnerRegistry(): OwnerRegistry {
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
        parent &&
          typeof parent.attributes['agent_trace.tool.name'] === 'string'
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
      const color =
        SUBAGENT_PALETTE[paletteCursor % SUBAGENT_PALETTE.length];
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

function finalizeOwnerLabels(owners: OwnerInfo[]) {
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

function flattenTurn(
  turn: Turn,
  registry: OwnerRegistry,
  ownersSeen: OwnerInfo[],
): ChartFlatSpan[] {
  const out: ChartFlatSpan[] = [];
  const visit = (
    node: SpanNode,
    parent: SpanNode | null,
    owner: OwnerInfo,
  ) => {
    let nextOwner = owner;
    if (node.name.startsWith('subagent:')) {
      nextOwner = registry.resolve(node, parent);
      if (!ownersSeen.includes(nextOwner)) ownersSeen.push(nextOwner);
    }
    out.push({
      node,
      turnNumber: turn.turnNumber,
      startMs: node.startMs,
      endMs: node.endMs,
      owner: nextOwner,
    });
    for (const child of node.children) visit(child, node, nextOwner);
  };
  for (const child of turn.root.children) visit(child, turn.root, MAIN_OWNER);
  return out;
}

function deriveRows(
  turns: readonly Turn[],
): { rows: Row[]; owners: OwnerInfo[] } {
  const registry = createOwnerRegistry();
  const ownersSeen: OwnerInfo[] = [MAIN_OWNER];
  const all: ChartFlatSpan[] = [];
  for (const turn of turns) {
    for (const f of flattenTurn(turn, registry, ownersSeen)) {
      all.push(f);
    }
  }
  finalizeOwnerLabels(ownersSeen);
  all.sort((a, b) => a.startMs - b.startMs);

  const seenRequest = new Set<string>();
  const rows: Row[] = [];
  // Per-owner lower bound. Subagent activity must not bleed into the main
  // agent's preceding-actions window (and vice versa) — different agents
  // run on different timelines and feed different prompts.
  const prevInferenceEndByOwner = new Map<string, number>();
  let lastTurnEmitted: number | null = null;
  let perTurnCounter = 0;
  let globalIndex = 0;

  const turnsByNumber = new Map<number, Turn>();
  for (const t of turns) turnsByNumber.set(t.turnNumber, t);

  for (const span of all) {
    if (span.node.name !== 'inference') continue;
    const reqId = String(
      span.node.attributes['agent_trace.inference.request_id'] ?? '',
    );
    if (lastTurnEmitted !== span.turnNumber) {
      perTurnCounter = 0;
    }
    if (reqId && seenRequest.has(reqId)) continue;
    if (reqId) seenRequest.add(reqId);

    perTurnCounter += 1;
    globalIndex += 1;
    const isTurnStart = lastTurnEmitted !== span.turnNumber;
    lastTurnEmitted = span.turnNumber;

    const a = span.node.attributes;
    const freshInput = Number(a['gen_ai.usage.input_tokens'] ?? 0);
    const cacheRead = Number(a['gen_ai.usage.cache_read_tokens'] ?? 0);
    const cacheCreation = Number(a['gen_ai.usage.cache_creation_tokens'] ?? 0);
    const total = freshInput + cacheRead + cacheCreation;
    const model =
      typeof a['gen_ai.request.model'] === 'string'
        ? (a['gen_ai.request.model'] as string)
        : null;

    // A tool's result enters this inference's prompt iff its tool_result
    // landed (endMs) between the previous same-owner inference and this
    // one. Filtering on startMs misses every tool — tool spans start
    // *inside* the inference that emitted the tool_use, so their startMs
    // sits at or before the previous inference's endMs.
    const precedingActions: PrecedingAction[] = [];
    const lowerBound =
      prevInferenceEndByOwner.get(span.owner.key) ?? Number.NEGATIVE_INFINITY;
    for (const other of all) {
      if (other.startMs >= span.startMs) break;
      if (other === span) continue;
      if (other.node.name === 'inference') continue;
      if (other.owner.key !== span.owner.key) continue;
      if (other.endMs <= lowerBound) continue;
      if (other.endMs > span.startMs) continue;
      const toolName =
        typeof other.node.attributes['agent_trace.tool.name'] === 'string'
          ? (other.node.attributes['agent_trace.tool.name'] as string)
          : other.node.name;
      const output =
        typeof other.node.attributes['agent_trace.tool.output_summary'] ===
          'string'
          ? (other.node.attributes['agent_trace.tool.output_summary'] as string)
          : '';
      precedingActions.push({ name: toolName, outputChars: output.length });
    }

    let trigger = '';
    if (isTurnStart) {
      const turn = turnsByNumber.get(span.turnNumber);
      trigger = turn?.userPrompt ?? '';
    } else {
      const promptAttr = a['agent_trace.inference.prompt'];
      if (typeof promptAttr === 'string') trigger = promptAttr;
    }

    const turnLabel = `Turn ${span.turnNumber}`;
    const inferenceLabel = `Inference ${perTurnCounter}`;
    rows.push({
      index: globalIndex,
      turnNumber: span.turnNumber,
      label: `${turnLabel} · ${inferenceLabel}`,
      turnLabel,
      inferenceLabel,
      cacheRead,
      cacheCreation,
      freshInput,
      total,
      ownerKey: span.owner.key,
      ownerLabel: span.owner.label,
      ownerKind: span.owner.kind,
      ownerToolName: span.owner.toolName,
      ownerColor: span.owner.color,
      model,
      trigger,
      precedingActions,
      isTurnStart,
    });

    prevInferenceEndByOwner.set(span.owner.key, span.endMs);
  }

  // Owners that actually own at least one inference, in first-seen order.
  // Used by the legend so it lists only what's visible on the chart.
  const usedKeys = new Set(rows.map((r) => r.ownerKey));
  const visibleOwners = ownersSeen.filter((o) => usedKeys.has(o.key));

  return { rows, owners: visibleOwners };
}

function buildChartConfig(owners: OwnerInfo[]): ChartConfig {
  const config: ChartConfig = {};
  for (const o of owners) {
    config[o.key] = {
      label: o.label,
      color: o.color,
    };
  }
  return config;
}

interface GradientStop {
  offset: number; // 0..1
  color: string;
}

// Walk consecutive same-owner runs and emit two stops per run. The trailing
// stop of one run and the leading stop of the next sit at the SAME offset
// (the boundary between them), so the color steps instantly with no
// interpolation between owners. The first run anchors at offset 0 and the
// last run anchors at offset 1 so the chart's edges are pure color too.
function buildGradientStops(rows: Row[]): GradientStop[] {
  if (rows.length === 0) return [];
  if (rows.length === 1) {
    return [
      { offset: 0, color: rows[0].ownerColor },
      { offset: 1, color: rows[0].ownerColor },
    ];
  }
  const span = rows.length - 1;
  const stops: GradientStop[] = [];
  let runStart = 0;
  for (let i = 1; i <= rows.length; i += 1) {
    const isLast = i === rows.length;
    const ownerChanged =
      isLast || rows[i].ownerKey !== rows[runStart].ownerKey;
    if (ownerChanged) {
      const color = rows[runStart].ownerColor;
      const startOffset = runStart === 0 ? 0 : runStart / span;
      const endOffset = isLast ? 1 : i / span;
      stops.push({ offset: startOffset, color });
      stops.push({ offset: endOffset, color });
      runStart = i;
    }
  }
  return stops;
}

interface Props {
  conversation: ConversationSummary;
}

export function ContextWindowChart({ conversation }: Props) {
  const { rows, owners } = useMemo(
    () => deriveRows(conversation.turns),
    [conversation.turns],
  );
  const chartConfig = useMemo(() => buildChartConfig(owners), [owners]);
  const stops = useMemo(() => buildGradientStops(rows), [rows]);
  const reactId = useId();
  const gradId = `ctx-grad-${reactId.replace(/:/g, '')}`;

  if (conversation.turns.length === 0) return null;

  return (
    <SectionCard
      title="Context window over time"
      footer={`${rows.length} inference${rows.length === 1 ? '' : 's'}`}
    >
      {rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          No inferences captured yet.
        </div>
      ) : (
        <ChartContainer config={chartConfig} className="aspect-[16/5] w-full">
          <AreaChart
            data={rows}
            margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
          >
            <defs>
              <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
                {stops.map((s, i) => (
                  <stop
                    key={i}
                    offset={`${(s.offset * 100).toFixed(4)}%`}
                    stopColor={s.color}
                    stopOpacity={0.55}
                  />
                ))}
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="index"
              type="number"
              domain={['dataMin', 'dataMax']}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              height={44}
              tick={<TwoLineTick rows={rows} />}
              interval="preserveStartEnd"
              minTickGap={32}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={4}
              tickFormatter={(value: number) => fmt.n(value)}
              width={48}
            />
            {rows
              .filter((r) => r.isTurnStart && r.index !== 1)
              .map((r) => (
                <ReferenceLine
                  key={r.index}
                  x={r.index}
                  stroke="hsl(var(--muted-foreground) / 0.4)"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
              ))}
            <ChartTooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={<ContextTooltip />}
            />
            <Area
              dataKey="total"
              name="Total context"
              type="monotone"
              fill={`url(#${gradId})`}
              stroke="var(--border)"
              strokeWidth={1}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
      {owners.length > 0 ? <OwnerLegend owners={owners} /> : null}
    </SectionCard>
  );
}

function OwnerLegend({ owners }: { owners: OwnerInfo[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-[11px]">
      {owners.map((o) => (
        <div key={o.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: o.color }}
          />
          <span className="min-w-0 truncate text-muted-foreground">
            {o.label}
          </span>
        </div>
      ))}
    </div>
  );
}

interface TwoLineTickProps {
  rows: Row[];
  x?: number;
  y?: number;
  payload?: { value: number };
  textAnchor?: 'inherit' | 'end' | 'start' | 'middle';
}

function TwoLineTick({
  rows,
  x = 0,
  y = 0,
  payload,
  textAnchor = 'middle',
}: TwoLineTickProps) {
  const row = rows.find((r) => r.index === payload?.value);
  if (!row) return null;
  return (
    <text
      x={x}
      y={y}
      textAnchor={textAnchor}
      fill="currentColor"
      className="fill-muted-foreground text-[11px]"
    >
      <tspan x={x} dy="0.71em">
        {row.turnLabel}
      </tspan>
      <tspan x={x} dy="1.1em">
        {row.inferenceLabel}
      </tspan>
    </text>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: Row;
    dataKey?: string;
    name?: string;
    value?: number;
    color?: string;
  }>;
  label?: string | number;
}

const ACTION_LIMIT = 5;
const TRIGGER_MAX_CHARS = 140;

const COMPOSITION_SEGMENTS = [
  { key: 'freshInput', short: 'fresh', color: 'var(--tok-fresh)' },
  { key: 'cacheRead', short: 'read', color: 'var(--tok-cache-read)' },
  { key: 'cacheCreation', short: 'write', color: 'var(--tok-cache-write)' },
] as const;

function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-[2px]"
      style={{ background: color }}
    />
  );
}

function ContextTooltip(props: TooltipProps) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  const triggerSnippet = row.trigger
    ? row.trigger.replace(/\s+/g, ' ').slice(0, TRIGGER_MAX_CHARS).trim()
    : '';
  const visibleActions = row.precedingActions.slice(0, ACTION_LIMIT);
  const remaining = row.precedingActions.length - visibleActions.length;
  const headerLabel =
    row.ownerKind === 'main' ? 'Main Conversation' : row.ownerLabel;

  return (
    <ChartTooltipShell className="flex flex-col gap-2 py-2">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ColorSwatch color={row.ownerColor} />
          <span className="min-w-0 truncate font-medium">{headerLabel}</span>
          {row.ownerKind === 'subagent' && row.ownerToolName ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              via {row.ownerToolName}
            </span>
          ) : null}
        </div>
        {row.model ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {row.model}
          </span>
        ) : null}
      </div>

      {row.total > 0 ? (
        <div className="flex flex-col gap-1 border-t border-border/50 pt-3">
          <div className="flex items-center justify-between font-mono uppercase text-muted-foreground">
            <span>Total context</span>
            <span className="font-medium tabular-nums">{fmt.n(row.total)}</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded bg-muted">
            {COMPOSITION_SEGMENTS.map((s) => (
              <span
                key={s.key}
                className="block h-full"
                style={{
                  width: `${(row[s.key] / row.total) * 100}%`,
                  background: s.color,
                }}
              />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[10.5px] text-muted-foreground">
            {COMPOSITION_SEGMENTS.map((s) => (
              <span key={s.key} className="flex min-w-0 items-center gap-1">
                <ColorSwatch color={s.color} />
                <span className="truncate">
                  {s.short} {fmt.n(row[s.key])}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {row.precedingActions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-muted-foreground">
            tool_results included
          </span>
          <ul className="flex flex-col gap-0.5">
            {visibleActions.map((a, i) => (
              <li
                key={`${a.name}-${i}`}
                className="flex min-w-0 items-center justify-between gap-3"
              >
                <span className="min-w-0 truncate font-mono text-[11px]">
                  {a.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {a.outputChars > 0 ? `${fmt.n(a.outputChars)} ch` : '—'}
                </span>
              </li>
            ))}
            {remaining > 0 ? (
              <li className="text-[10px] text-muted-foreground">
                +{remaining} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {triggerSnippet ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {row.isTurnStart ? 'User prompt' : 'Trigger'}
          </span>
          <p className="line-clamp-3 text-[11px] leading-snug">
            {triggerSnippet}
            {row.trigger.length > triggerSnippet.length ? '…' : ''}
          </p>
        </div>
      ) : null}

      <div className="border-t border-border/50 pt-1 text-[10px] text-muted-foreground">
        {row.label}
      </div>
    </ChartTooltipShell>
  );
}


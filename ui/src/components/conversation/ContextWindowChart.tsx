import { useMemo } from 'react';
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
  ChartLegend,
  ChartLegendContent,
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
  model: string | null;
  trigger: string;
  precedingActions: PrecedingAction[];
  isTurnStart: boolean;
  // dynamic per-owner y values (row[ownerKey] === total, others absent)
  [series: string]: unknown;
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

      const type =
        typeof attrs['agent_trace.subagent.type'] === 'string'
          ? (attrs['agent_trace.subagent.type'] as string)
          : node.name.replace(/^subagent:/, '') || 'subagent';
      const next = (dispatchCountsByType.get(type) ?? 0) + 1;
      dispatchCountsByType.set(type, next);

      const toolName =
        parent &&
        typeof parent.attributes['agent_trace.tool.name'] === 'string'
          ? (parent.attributes['agent_trace.tool.name'] as string)
          : null;

      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const color =
        SUBAGENT_PALETTE[paletteCursor % SUBAGENT_PALETTE.length];
      paletteCursor += 1;
      const info: OwnerInfo = {
        key: `sub_${safeId}`,
        // label is finalized after registry walk so single-dispatch types stay un-numbered
        label: type,
        kind: 'subagent',
        toolName,
        color,
      };
      // store with a sentinel index marker so we can re-label after the walk
      byId.set(id, info);
      // attach type + index for post-pass relabeling
      (info as OwnerInfo & { __type: string; __index: number }).__type = type;
      (info as OwnerInfo & { __type: string; __index: number }).__index = next;
      return info;
    },
  };
}

// After registry has seen all subagents, finalize labels: types with multiple
// dispatches get suffixed `#N`, single-dispatch types keep the bare type label.
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
  let prevInferenceEnd: number | null = null;
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

    const precedingActions: PrecedingAction[] = [];
    const lowerBound = prevInferenceEnd ?? Number.NEGATIVE_INFINITY;
    for (const other of all) {
      if (other === span) continue;
      if (other.node.name === 'inference') continue;
      if (other.startMs <= lowerBound) continue;
      if (other.startMs >= span.startMs) break;
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
    const row: Row = {
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
      model,
      trigger,
      precedingActions,
      isTurnStart,
    };
    // Stacked-area shape: every series is present on every row. The owner
    // carries the full context total; all other series are 0. The stacked
    // height at each x therefore equals exactly one owner's value.
    for (const o of ownersSeen) {
      row[o.key] = o.key === span.owner.key ? total : 0;
    }
    rows.push(row);

    prevInferenceEnd = span.endMs;
  }

  // Drop owners that ended up with no inference rows attributed to them
  // (e.g. a subagent span existed but yielded no inference yet).
  const usedKeys = new Set(rows.map((r) => r.ownerKey));
  const owners = ownersSeen.filter(
    (o) => usedKeys.has(o.key) || o.kind === 'main',
  );
  // Drop main if no inference ever ran in main scope.
  const finalOwners = owners.filter(
    (o) => usedKeys.has(o.key) || (o.kind === 'main' && rows.length === 0),
  );

  // For each subagent series, keep one zero-anchor on each side of its active
  // range (so Recharts tapers the area down to 0 on the next inference rather
  // than ending in a vertical cliff) and null out everything beyond. Main
  // always stays numeric so its area is continuous across the conversation.
  const finalOwnerList = finalOwners.length > 0 ? finalOwners : owners;
  for (const o of finalOwnerList) {
    if (o.kind !== 'subagent') continue;
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const v = rows[i][o.key];
      if (typeof v === 'number' && v > 0) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1) continue;
    const leadAnchor = firstIdx - 1;
    const trailAnchor = lastIdx + 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (i === leadAnchor || i === trailAnchor) {
        rows[i][o.key] = 0;
      } else if (i < firstIdx || i > lastIdx) {
        rows[i][o.key] = null;
      }
    }
  }

  return { rows, owners: finalOwnerList };
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

interface Props {
  conversation: ConversationSummary;
}

export function ContextWindowChart({ conversation }: Props) {
  const { rows, owners } = useMemo(
    () => deriveRows(conversation.turns),
    [conversation.turns],
  );
  const chartConfig = useMemo(() => buildChartConfig(owners), [owners]);

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
                  stroke="var(--border)"
                  strokeDasharray="2 4"
                />
              ))}
            <ChartTooltip
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
              content={<ContextTooltip />}
            />
            {owners.map((o) => (
              <Area
                key={o.key}
                dataKey={o.key}
                name={o.label}
                type="monotone"
                stackId="ctx"
                stroke={o.color}
                fill={o.color}
                fillOpacity={0.55}
                strokeWidth={1.5}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      )}
    </SectionCard>
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

function ContextTooltip(props: TooltipProps) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  // Find the entry whose value matches this row's owner key. With sparse data
  // (owners other than this row's owner are null), Recharts may include several
  // payload entries; pick the one with a numeric value.
  const entry = payload.find((p) => typeof p.value === 'number') ?? payload[0];
  const row = entry.payload;
  const triggerSnippet = row.trigger
    ? row.trigger.replace(/\s+/g, ' ').slice(0, 140).trim()
    : '';
  const visibleActions = row.precedingActions.slice(0, 5);
  const remaining = row.precedingActions.length - visibleActions.length;
  const ownerSwatch = entry.color;

  return (
    <ChartTooltipShell className="py-2">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="font-medium">
          Inference #{row.index}{' '}
          <span className="text-muted-foreground">· {row.label}</span>
        </span>
        {row.model ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {row.model}
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          {ownerSwatch ? (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: ownerSwatch }}
            />
          ) : null}
          <span className="text-muted-foreground">
            {row.ownerKind === 'main' ? 'Owner' : 'Owned by'}
          </span>
          <span className="min-w-0 truncate font-medium">{row.ownerLabel}</span>
        </div>
        {row.ownerKind === 'subagent' && row.ownerToolName ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            via {row.ownerToolName}
          </span>
        ) : null}
      </div>

      <div className="grid gap-0.5 border-t border-border/50 pt-1">
        <BreakdownRow label="Cache read" value={row.cacheRead} />
        <BreakdownRow label="Cache creation" value={row.cacheCreation} />
        <BreakdownRow label="Fresh input" value={row.freshInput} />
      </div>

      <div className="flex items-center justify-between border-t border-border/50 pt-1">
        <span className="font-medium">Total context</span>
        <span className="font-mono font-medium tabular-nums">
          {fmt.n(row.total)}
        </span>
      </div>

      {row.precedingActions.length > 0 ? (
        <div className="grid gap-1">
          <span className="text-muted-foreground">
            Since previous inference
          </span>
          <ul className="grid gap-0.5">
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
        <div className="grid gap-1">
          <span className="text-muted-foreground">
            {row.isTurnStart ? 'User prompt' : 'Trigger'}
          </span>
          <p className="line-clamp-3 text-[11px] leading-snug">
            {triggerSnippet}
            {row.trigger.length > triggerSnippet.length ? '…' : ''}
          </p>
        </div>
      ) : null}
    </ChartTooltipShell>
  );
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{fmt.n(value)}</span>
    </div>
  );
}

import { type ChartConfig, ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { ChartTooltipShell } from '@/components/ui/chart-tooltip-shell';
import { SectionCard } from '@/components/ui/section-card';
import { toolDetail } from '@/components/waterfall-span';
import type { ConversationSummary, Turn } from '@/types';
import { MessageCircle } from 'lucide-react';
import { useId, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { fmt } from './format';
import {
  type FlatOwnedSpan,
  MAIN_OWNER,
  type OwnerInfo,
  type OwnerRegistry,
  createOwnerRegistry,
  finalizeOwnerLabels,
  flattenOwnedSpansForTurn,
} from './ownerRegistry';

interface PrecedingAction {
  name: string;
  // One level deeper than `name` — file path for Read/Edit/Write, command
  // for Bash, pattern for Grep/Glob, etc. `null` for tools without a
  // structured field mapping in TOOL_LABEL_FIELDS (e.g. ToolSearch).
  detail: string | null;
  outputChars: number;
}

interface InferenceTokens {
  total: number;
  freshInput: number;
  cacheRead: number;
  cacheCreation: number;
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
  // User's typed prompt — only populated when isTurnStart.
  userPrompt: string;
  // Assistant response content from this inference's events. Either may be
  // empty (tool-use-only inferences have neither).
  responseText: string;
  responseThinking: string;
  precedingActions: PrecedingAction[];
  // Token delta vs. the previous inference of the SAME owner. `null` for an
  // owner's very first inference. Same-owner-only so cross-agent comparisons
  // (Main vs. Explore) don't produce nonsense numbers.
  delta: InferenceTokens | null;
  isTurnStart: boolean;
}

const MESSAGE_CONTENT_ATTR = 'gen_ai.message.content';
const REASONING_CONTENT_ATTR = 'gen_ai.reasoning.content';

function deriveRows(turns: readonly Turn[]): { rows: Row[]; owners: OwnerInfo[] } {
  const registry: OwnerRegistry = createOwnerRegistry();
  const ownersSeen: OwnerInfo[] = [MAIN_OWNER];
  const all: FlatOwnedSpan<number>[] = [];
  for (const turn of turns) {
    for (const f of flattenOwnedSpansForTurn(turn, registry, ownersSeen)) {
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
  // Per-owner token totals of the previous inference. Used to compute the
  // delta shown in the tooltip ("how much context grew from the prior
  // same-owner inference"). Same-owner scoping is deliberate — cross-owner
  // deltas would compare apples to oranges.
  const prevTotalsByOwner = new Map<string, InferenceTokens>();
  let lastTurnEmitted: number | null = null;
  let perTurnCounter = 0;
  let globalIndex = 0;

  const turnsByNumber = new Map<number, Turn>();
  for (const t of turns) turnsByNumber.set(t.turnNumber, t);

  for (const span of all) {
    if (span.node.name !== 'inference') continue;
    const reqId = String(span.node.attributes['agent_trace.inference.request_id'] ?? '');
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
      typeof a['gen_ai.request.model'] === 'string' ? (a['gen_ai.request.model'] as string) : null;

    // A tool's result enters this inference's prompt iff its tool_result
    // landed (endMs) between the previous same-owner inference and this
    // one. Filtering on startMs misses every tool — tool spans start
    // *inside* the inference that emitted the tool_use, so their startMs
    // sits at or before the previous inference's endMs.
    const precedingActions: PrecedingAction[] = [];
    const lowerBound = prevInferenceEndByOwner.get(span.owner.key) ?? Number.NEGATIVE_INFINITY;
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
        typeof other.node.attributes['agent_trace.tool.output_summary'] === 'string'
          ? (other.node.attributes['agent_trace.tool.output_summary'] as string)
          : '';
      const detail = toolDetail(toolName, other.node.attributes['agent_trace.tool.input_summary']);
      precedingActions.push({ name: toolName, detail, outputChars: output.length });
    }

    let userPrompt = '';
    if (isTurnStart) {
      const turn = turnsByNumber.get(span.turnNumber);
      userPrompt = turn?.userPrompt ?? '';
    }

    // Assistant response content lives as events on the inference span. Same
    // access pattern as transforms.ts:445-481. Either or both may be empty
    // — a tool-use-only inference has no text and no reasoning content.
    let responseText = '';
    let responseThinking = '';
    for (const e of span.node.events) {
      if (e.name === 'gen_ai.assistant.message') {
        responseText = String(e.attributes?.[MESSAGE_CONTENT_ATTR] ?? '');
      } else if (e.name === 'gen_ai.assistant.reasoning') {
        responseThinking = String(e.attributes?.[REASONING_CONTENT_ATTR] ?? '');
      }
    }

    const prevTotals = prevTotalsByOwner.get(span.owner.key);
    const delta: InferenceTokens | null = prevTotals
      ? {
          total: total - prevTotals.total,
          freshInput: freshInput - prevTotals.freshInput,
          cacheRead: cacheRead - prevTotals.cacheRead,
          cacheCreation: cacheCreation - prevTotals.cacheCreation,
        }
      : null;

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
      userPrompt,
      responseText,
      responseThinking,
      precedingActions,
      delta,
      isTurnStart,
    });

    prevInferenceEndByOwner.set(span.owner.key, span.endMs);
    prevTotalsByOwner.set(span.owner.key, { total, freshInput, cacheRead, cacheCreation });
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
    const ownerChanged = isLast || rows[i].ownerKey !== rows[runStart].ownerKey;
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
  const { rows, owners } = useMemo(() => deriveRows(conversation.turns), [conversation.turns]);
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
          <AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <defs>
              <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
                {stops.map((s, i) => (
                  <stop
                    // biome-ignore lint/suspicious/noArrayIndexKey: gradient stops are positional and don't reorder
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
              dot={<ContextDot />}
              activeDot={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
      {owners.length > 0 ? <OwnerLegend owners={owners} /> : null}
      {rows.length > 0 ? <MarkerLegend /> : null}
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
          <span className="min-w-0 truncate text-muted-foreground">{o.label}</span>
        </div>
      ))}
    </div>
  );
}

function MarkerLegend() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <MessageCircle aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.75} />
        <span>user prompt</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
        <span>inference trigger</span>
      </div>
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

function TwoLineTick({ rows, x = 0, y = 0, payload, textAnchor = 'middle' }: TwoLineTickProps) {
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

interface ContextDotProps {
  cx?: number;
  cy?: number;
  payload?: Row;
}

const USER_PROMPT_ICON_SIZE = 14;

function ContextDot({ cx, cy, payload }: ContextDotProps) {
  if (cx == null || cy == null || !payload) return null;
  if (payload.isTurnStart) {
    // Lucide paths bake fill="none", so the icon's own fill prop won't paint the
    // bubble interior — back it with a solid white circle to punch through the
    // area gradient.
    return (
      <g style={{ pointerEvents: 'none' }}>
        <circle cx={cx} cy={cy} r={USER_PROMPT_ICON_SIZE / 2 - 1} fill="#ffffff" />
        <MessageCircle
          x={cx - USER_PROMPT_ICON_SIZE / 2}
          y={cy - USER_PROMPT_ICON_SIZE / 2}
          width={USER_PROMPT_ICON_SIZE}
          height={USER_PROMPT_ICON_SIZE}
          stroke={payload.ownerColor}
          strokeWidth={1.75}
          fill="none"
        />
      </g>
    );
  }
  return (
    <circle cx={cx} cy={cy} r={1.25} fill={payload.ownerColor} style={{ pointerEvents: 'none' }} />
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
const USER_PROMPT_MAX_CHARS = 140;
const RESPONSE_MAX_CHARS = 280;

const COMPOSITION_SEGMENTS = [
  { key: 'freshInput', short: 'fresh', color: 'var(--tok-fresh)' },
  { key: 'cacheRead', short: 'read', color: 'var(--tok-cache-read)' },
  { key: 'cacheCreation', short: 'write', color: 'var(--tok-cache-write)' },
] as const;

function ColorSwatch({ color }: { color: string }) {
  return (
    <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
  );
}

function DeltaBadge({ value }: { value: number }) {
  const tone =
    value > 0 ? 'text-emerald-500' : value < 0 ? 'text-rose-500' : 'text-muted-foreground/60';
  return <span className={`ml-1 ${tone}`}>({signedFmt(value)})</span>;
}

function snippet(value: string, max: number): string {
  if (!value) return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trim()}…`;
}

function signedFmt(n: number): string {
  if (n > 0) return `+${fmt.n(n)}`;
  if (n < 0) return `−${fmt.n(-n)}`;
  return '0';
}

function ContextTooltip(props: TooltipProps) {
  const { active, payload } = props;
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;

  const userPromptSnippet = row.isTurnStart ? snippet(row.userPrompt, USER_PROMPT_MAX_CHARS) : '';
  const responseTextSnippet = snippet(row.responseText, RESPONSE_MAX_CHARS);
  const responseThinkingSnippet = snippet(row.responseThinking, RESPONSE_MAX_CHARS);
  const hasResponse = Boolean(responseTextSnippet || responseThinkingSnippet);
  const visibleActions = row.precedingActions.slice(0, ACTION_LIMIT);
  const remaining = row.precedingActions.length - visibleActions.length;
  const headerLabel = row.ownerKind === 'main' ? 'Main Conversation' : row.ownerLabel;

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
                  {row.delta ? <DeltaBadge value={row.delta[s.key]} /> : null}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {row.precedingActions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-muted-foreground">tool_results included</span>
          <ul className="flex flex-col gap-0.5">
            {visibleActions.map((a, i) => (
              <li
                key={`${a.name}-${i}`}
                className="flex min-w-0 items-center justify-between gap-3"
              >
                <span className="min-w-0 truncate font-mono text-[11px]">
                  {a.name}
                  {a.detail ? <span className="text-muted-foreground">: {a.detail}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {a.outputChars > 0 ? `${fmt.n(a.outputChars)} ch` : '—'}
                </span>
              </li>
            ))}
            {remaining > 0 ? (
              <li className="text-[10px] text-muted-foreground">+{remaining} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {row.isTurnStart && userPromptSnippet ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">User Prompt</span>
          <p className="line-clamp-3 text-[11px] leading-snug">{userPromptSnippet}</p>
        </div>
      ) : null}

      {!row.isTurnStart && hasResponse ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Assistant Response</span>
          {responseThinkingSnippet ? (
            <p className="line-clamp-3 text-[11px] italic leading-snug text-muted-foreground">
              {responseThinkingSnippet}
            </p>
          ) : null}
          {responseTextSnippet ? (
            <p className="line-clamp-3 text-[11px] leading-snug">{responseTextSnippet}</p>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-border/50 pt-1 text-[10px] text-muted-foreground">
        {row.label}
      </div>
    </ChartTooltipShell>
  );
}

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
import { fmt } from './format';

interface PrecedingAction {
  name: string;
  outputChars: number;
}

interface Row {
  index: number;
  turnNumber: number;
  label: string;
  cacheRead: number;
  cacheCreation: number;
  freshInput: number;
  total: number;
  model: string | null;
  trigger: string;
  precedingActions: PrecedingAction[];
  isTurnStart: boolean;
}

interface ChartFlatSpan {
  node: SpanNode;
  turnNumber: number;
  inferencesInTurn: number;
}

const chartConfig: ChartConfig = {
  cacheRead: { label: 'Cache read', color: 'var(--tok-cache-read)' },
  cacheCreation: { label: 'Cache creation', color: 'var(--tok-cache-write)' },
  freshInput: { label: 'Fresh input', color: 'var(--tok-fresh)' },
} satisfies ChartConfig;

function flattenTurn(turn: Turn): ChartFlatSpan[] {
  const out: ChartFlatSpan[] = [];
  let inferencesInTurn = 0;
  const visit = (node: SpanNode) => {
    if (node.name === 'inference') inferencesInTurn += 1;
    out.push({ node, turnNumber: turn.turnNumber, inferencesInTurn });
    for (const child of node.children) visit(child);
  };
  for (const child of turn.root.children) visit(child);
  return out;
}

function deriveRows(turns: readonly Turn[]): Row[] {
  type FlatSpan = ChartFlatSpan & { startMs: number; endMs: number };
  const all: FlatSpan[] = [];
  for (const turn of turns) {
    for (const f of flattenTurn(turn)) {
      all.push({ ...f, startMs: f.node.startMs, endMs: f.node.endMs });
    }
  }
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
    // Always advance per-turn counter on first inference of a turn so labels
    // stay correct even if we skip a duplicate-requestId span.
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

    rows.push({
      index: globalIndex,
      turnNumber: span.turnNumber,
      label: `Turn ${span.turnNumber} · Inference ${perTurnCounter}`,
      cacheRead,
      cacheCreation,
      freshInput,
      total,
      model,
      trigger,
      precedingActions,
      isTurnStart,
    });

    prevInferenceEnd = span.endMs;
  }

  return rows;
}

interface Props {
  conversation: ConversationSummary;
}

export function ContextWindowChart({ conversation }: Props) {
  const rows = useMemo(
    () => deriveRows(conversation.turns),
    [conversation.turns],
  );

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
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
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
              tickFormatter={(value) => {
                const row = rows.find((r) => r.index === value);
                return row ? row.label : String(value);
              }}
              interval="preserveStartEnd"
              minTickGap={64}
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
            <Area
              dataKey="cacheRead"
              type="monotone"
              stackId="ctx"
              stroke="var(--color-cacheRead)"
              fill="var(--color-cacheRead)"
              fillOpacity={0.55}
              strokeWidth={1.5}
            />
            <Area
              dataKey="cacheCreation"
              type="monotone"
              stackId="ctx"
              stroke="var(--color-cacheCreation)"
              fill="var(--color-cacheCreation)"
              fillOpacity={0.55}
              strokeWidth={1.5}
            />
            <Area
              dataKey="freshInput"
              type="monotone"
              stackId="ctx"
              stroke="var(--color-freshInput)"
              fill="var(--color-freshInput)"
              fillOpacity={0.55}
              strokeWidth={1.5}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      )}
    </SectionCard>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload: Row }>;
}

function ContextTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const triggerSnippet = row.trigger
    ? row.trigger.replace(/\s+/g, ' ').slice(0, 140).trim()
    : '';
  const visibleActions = row.precedingActions.slice(0, 5);
  const remaining = row.precedingActions.length - visibleActions.length;

  return (
    <div className="grid w-max min-w-[16rem] max-w-[min(28rem,calc(100vw-3rem))] gap-2 overflow-hidden rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
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

      <div className="grid gap-1">
        <TokenRow
          color="var(--tok-cache-read)"
          label="Cache read"
          value={row.cacheRead}
        />
        <TokenRow
          color="var(--tok-cache-write)"
          label="Cache creation"
          value={row.cacheCreation}
        />
        <TokenRow
          color="var(--tok-fresh)"
          label="Fresh input"
          value={row.freshInput}
        />
        <div className="mt-0.5 flex items-center justify-between border-t border-border/50 pt-1">
          <span className="font-medium">Total context</span>
          <span className="font-mono font-medium tabular-nums">
            {fmt.n(row.total)}
          </span>
        </div>
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
                <span className="min-w-0 truncate font-mono text-[11px]">{a.name}</span>
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
    </div>
  );
}

interface TokenRowProps {
  color: string;
  label: string;
  value: number;
}

function TokenRow({ color, label, value }: TokenRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-[2px]"
          style={{ background: color }}
        />
        <span className="text-muted-foreground">{label}</span>
      </span>
      <span className="font-mono tabular-nums">{fmt.n(value)}</span>
    </div>
  );
}

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ui/chart';
import { SectionCard } from '@/components/ui/section-card';
import { ChartTooltipShell } from '@/components/ui/chart-tooltip-shell';
import type { ConversationSummary } from '@/types';
import {
  buildConversationSteps,
  type ConversationStep,
  type ConversationStepKind,
} from './transforms';

interface Props {
  conversation: ConversationSummary;
}

interface ChartDatum {
  idx: number;
  turnNumber: number | null;
  label: string;
  model: string | null;
  before: number;
  after: number;
  delta: number;
  fresh: number;
  cacheRead: number;
  cacheCreation: number;
  composition: { fresh: number; cacheRead: number; cacheCreation: number };
  intervening: ConversationStep[];
  isFirstOfTurn: boolean;
  isFirstAfterUnattached: boolean;
}

const fmt = {
  n(x: number): string {
    if (!Number.isFinite(x)) return '—';
    const abs = Math.abs(x);
    if (abs === 0) return '0';
    if (abs < 1000) return String(Math.round(x));
    if (abs < 1e6)
      return (x / 1000).toFixed(abs < 10000 ? 2 : 1).replace(/\.0+$/, '') + 'k';
    return (x / 1e6).toFixed(2) + 'M';
  },
  signed(x: number): string {
    if (x === 0) return '0';
    return (x > 0 ? '+' : '−') + fmt.n(Math.abs(x));
  },
};

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const KIND_GLYPH: Record<ConversationStepKind, string> = {
  'user-prompt': 'U',
  inference: '∞',
  tool: '$',
  'assistant-message': 'A',
  reasoning: '?',
};

const KIND_COLOR: Record<ConversationStepKind, string> = {
  'user-prompt': 'var(--tool-user)',
  inference: 'var(--tool-inference)',
  tool: 'var(--tool-bash)',
  'assistant-message': 'var(--tok-output)',
  reasoning: 'var(--tok-output)',
};

const KIND_LABEL: Record<ConversationStepKind, string> = {
  'user-prompt': 'user prompt',
  inference: 'inference',
  tool: 'tool',
  'assistant-message': 'assistant message',
  reasoning: 'reasoning',
};

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

function buildData(conversation: ConversationSummary): ChartDatum[] {
  const steps = buildConversationSteps(conversation);
  const out: ChartDatum[] = [];
  let pending: ConversationStep[] = [];
  let prevAbsolute = 0;
  let prevTurnNumber: number | null = null;
  let prevTraceId: string | null = null;
  let withinBucket = 0;

  for (const step of steps) {
    if (step.kind !== 'inference') {
      pending.push(step);
      continue;
    }
    const isUnattached = step.turnNumber === null;
    const crossingUnattachedBoundary =
      isUnattached && prevTraceId !== step.traceId;
    if (crossingUnattachedBoundary) {
      prevAbsolute = 0;
    }
    const isFirstOfTurn =
      step.turnNumber !== null && step.turnNumber !== prevTurnNumber;
    if (isFirstOfTurn || crossingUnattachedBoundary) withinBucket = 0;
    withinBucket += 1;
    const after =
      step.tokens.input + step.tokens.cacheRead + step.tokens.cacheCreation;
    const before = prevAbsolute;
    const fresh = step.tokens.input;
    const cacheRead = step.tokens.cacheRead;
    const cacheCreation = step.tokens.cacheCreation;
    out.push({
      idx: out.length + 1,
      turnNumber: step.turnNumber,
      label:
        step.turnNumber !== null
          ? `Turn ${step.turnNumber} · Inference ${withinBucket}`
          : `Unattached · Inference ${withinBucket}`,
      model:
        (step.span?.attributes['gen_ai.request.model'] as string | undefined) ??
        null,
      before,
      after,
      delta: after - before,
      fresh,
      cacheRead,
      cacheCreation,
      composition: { fresh, cacheRead, cacheCreation },
      intervening: pending,
      isFirstOfTurn,
      isFirstAfterUnattached: crossingUnattachedBoundary,
    });
    pending = [];
    prevAbsolute = after;
    prevTurnNumber = step.turnNumber;
    prevTraceId = step.traceId;
  }
  return out;
}

const CHART_CONFIG = {
  cacheRead: { label: 'Cache read', color: 'var(--tok-cache-read)' },
  cacheCreation: { label: 'Cache creation', color: 'var(--tok-cache-write)' },
  fresh: { label: 'Fresh input', color: 'var(--tok-fresh)' },
} satisfies ChartConfig;

export function ConversationContextChart({ conversation }: Props) {
  const data = useMemo(() => buildData(conversation), [conversation]);
  if (data.length === 0) return null;

  const peakAfter = data.reduce((m, d) => (d.after > m ? d.after : m), 0);
  const turnBoundaryIndices = data
    .filter((d) => d.idx > 1 && d.isFirstOfTurn)
    .map((d) => d.idx);
  const unattachedBoundaryIndices = data
    .filter((d) => d.isFirstAfterUnattached)
    .map((d) => d.idx);

  return (
    <SectionCard
      title="Context per inference"
      footer={`${pluralize(data.length, 'inference')} · peak ${fmt.n(peakAfter)} tok`}
    >
      <ChartContainer
        config={CHART_CONFIG}
        className="aspect-[16/5] w-full"
      >
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="idx"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(value) =>
              data.find((d) => d.idx === value)?.label ?? String(value)
            }
            interval="preserveStartEnd"
            minTickGap={64}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => fmt.n(Number(v))}
          />
          <ReferenceLine y={0} stroke="hsl(var(--border))" />
          {turnBoundaryIndices.map((idx) => (
            <ReferenceLine
              key={`turn-${idx}`}
              x={idx}
              stroke="hsl(var(--border))"
              strokeDasharray="2 4"
            />
          ))}
          {unattachedBoundaryIndices.map((idx) => (
            <ReferenceLine
              key={`unattached-${idx}`}
              x={idx}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              label={{
                value: 'unattached',
                position: 'insideTopLeft',
                fontSize: 10,
                fill: 'hsl(var(--muted-foreground))',
              }}
            />
          ))}
          <ChartTooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={<ContextTooltip />}
          />
          <Bar
            dataKey="cacheRead"
            stackId="ctx"
            fill="var(--color-cacheRead)"
          />
          <Bar
            dataKey="cacheCreation"
            stackId="ctx"
            fill="var(--color-cacheCreation)"
          />
          <Bar
            dataKey="fresh"
            stackId="ctx"
            fill="var(--color-fresh)"
            radius={[2, 2, 0, 0]}
          />
          <ChartLegend content={<ChartLegendContent />} />
        </BarChart>
      </ChartContainer>
    </SectionCard>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ChartDatum }>;
}

function ContextTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;

  const isInitial = datum.idx === 1 || datum.isFirstAfterUnattached;
  const compTotal =
    datum.composition.fresh +
    datum.composition.cacheRead +
    datum.composition.cacheCreation;
  const counts = datum.intervening.reduce(
    (acc, s) => {
      acc[s.kind] = (acc[s.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<ConversationStepKind, number>,
  );
  const countLine = (Object.keys(counts) as ConversationStepKind[])
    .map((k) => pluralize(counts[k] ?? 0, KIND_LABEL[k]))
    .join(' · ');
  const itemLimit = 5;
  const items = datum.intervening.slice(0, itemLimit);
  const overflow = datum.intervening.length - items.length;

  return (
    <ChartTooltipShell>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="whitespace-nowrap font-medium">
          Inference {datum.idx}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {datum.turnNumber !== null
            ? `Turn ${datum.turnNumber}`
            : 'unattached'}
          {datum.model ? ` · ${datum.model}` : ''}
        </span>
      </div>

      {isInitial ? (
        <div className="flex items-baseline justify-between gap-2 font-mono">
          <span className="text-muted-foreground">Initial context</span>
          <span className="font-medium">{fmt.n(datum.after)} tok</span>
        </div>
      ) : (
        <div className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 font-mono text-[11.5px]">
          <span className="text-muted-foreground">before</span>
          <span className="text-foreground">{fmt.n(datum.before)}</span>
          <span />
          <span className="text-muted-foreground">after</span>
          <span className="text-foreground">{fmt.n(datum.after)}</span>
          <span
            className={
              'ml-2 font-medium ' +
              (datum.delta >= 0 ? 'text-foreground' : 'text-destructive')
            }
          >
            Δ {fmt.signed(datum.delta)}
          </span>
        </div>
      )}

      {compTotal > 0 && (
        <div>
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
            Composition
          </div>
          <div className="flex h-2 overflow-hidden rounded bg-muted">
            <span
              className="block h-full"
              style={{
                width: `${(datum.composition.fresh / compTotal) * 100}%`,
                background: 'var(--tok-fresh)',
              }}
            />
            <span
              className="block h-full"
              style={{
                width: `${(datum.composition.cacheRead / compTotal) * 100}%`,
                background: 'var(--tok-cache-read)',
              }}
            />
            <span
              className="block h-full"
              style={{
                width: `${(datum.composition.cacheCreation / compTotal) * 100}%`,
                background: 'var(--tok-cache-write)',
              }}
            />
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10.5px] text-muted-foreground">
            <span>fresh {fmt.n(datum.composition.fresh)}</span>
            <span>read {fmt.n(datum.composition.cacheRead)}</span>
            <span>write {fmt.n(datum.composition.cacheCreation)}</span>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
          Intervening steps
        </div>
        {datum.intervening.length === 0 ? (
          <div className="text-[11.5px] text-muted-foreground/80">
            {isInitial
              ? 'Initial inference — no prior context.'
              : 'No intervening steps.'}
          </div>
        ) : (
          <>
            <div className="mb-1.5 font-mono text-[10.5px] text-muted-foreground/80">
              {countLine}
            </div>
            <ul className="space-y-1">
              {items.map((s) => (
                <li
                  key={s.id}
                  className="flex min-w-0 items-center gap-1.5 text-[11.5px]"
                >
                  <span
                    className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded font-mono text-[9px] font-semibold text-white"
                    style={{ background: KIND_COLOR[s.kind] }}
                  >
                    {KIND_GLYPH[s.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {s.label}
                  </span>
                  {s.outputTokens > 0 && (
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {fmt.n(s.outputTokens)} tok
                    </span>
                  )}
                  {s.outputTokens === 0 && s.outputBytes > 0 && (
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {fmtBytes(s.outputBytes)}
                    </span>
                  )}
                </li>
              ))}
              {overflow > 0 && (
                <li className="font-mono text-[10.5px] text-muted-foreground/70">
                  … +{overflow} more
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </ChartTooltipShell>
  );
}

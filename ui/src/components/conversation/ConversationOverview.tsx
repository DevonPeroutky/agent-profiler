import type { ConversationSummary, SpanNode, Turn } from '@/types';
import { fmt } from './format';

interface Props {
  conversation: ConversationSummary;
}

interface InferenceWalk {
  peakContext: number;
}

function walkPeakContext(node: SpanNode, acc: InferenceWalk): InferenceWalk {
  if (node.name === 'inference') {
    const input = Number(node.attributes['gen_ai.usage.input_tokens'] ?? 0);
    const cacheRead = Number(node.attributes['gen_ai.usage.cache_read_tokens'] ?? 0);
    const cacheCreation = Number(node.attributes['gen_ai.usage.cache_creation_tokens'] ?? 0);
    const ctx = input + cacheRead + cacheCreation;
    if (ctx > acc.peakContext) acc.peakContext = ctx;
  }
  for (const child of node.children) walkPeakContext(child, acc);
  return acc;
}

function deriveAggregates(turns: readonly Turn[]) {
  let totalFresh = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalOutput = 0;
  let inferenceCount = 0;
  const walk: InferenceWalk = { peakContext: 0 };

  for (const turn of turns) {
    totalFresh += turn.contextTokens.input;
    totalCacheRead += turn.contextTokens.cacheRead;
    totalCacheWrite += turn.contextTokens.cacheCreation;
    totalOutput += turn.contextTokens.output;
    inferenceCount += Number(turn.root.attributes['agent_trace.turn.request_count'] ?? 0);
    walkPeakContext(turn.root, walk);
  }

  const totalInput = totalFresh + totalCacheRead + totalCacheWrite;
  const cacheHitRate = totalInput === 0 ? 0 : totalCacheRead / totalInput;
  const contextWindow = walk.peakContext > 200_000 ? 1_000_000 : 200_000;

  return {
    totalFresh,
    totalCacheRead,
    totalCacheWrite,
    totalOutput,
    totalInput,
    peakContext: walk.peakContext,
    cacheHitRate,
    inferenceCount,
    contextWindow,
  };
}

export function ConversationOverview({ conversation }: Props) {
  if (conversation.turns.length === 0) return null;

  const a = deriveAggregates(conversation.turns);
  const { turnCount, toolCount, durationMs } = conversation;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Overview
        </h2>
        <span className="text-xs text-muted-foreground/70">
          {turnCount} turn{turnCount === 1 ? '' : 's'} · {toolCount} tool call
          {toolCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Metric label="Total input" value={fmt.n(a.totalInput)} unit="tok">
          <StackedBar
            total={Math.max(1, a.totalInput)}
            segments={[
              { value: a.totalFresh, color: 'var(--tok-fresh)' },
              { value: a.totalCacheRead, color: 'var(--tok-cache-read)' },
              { value: a.totalCacheWrite, color: 'var(--tok-cache-write)' },
            ]}
          />
        </Metric>
        <Metric
          label="Total output"
          value={fmt.n(a.totalOutput)}
          unit="tok"
          sub={
            <span className="text-xs text-muted-foreground">
              {fmt.n(Math.round(a.totalOutput / Math.max(1, a.inferenceCount)))} avg / inference
            </span>
          }
        />
        <Metric
          label="Peak context"
          value={fmt.n(a.peakContext)}
          unit="tok"
          sub={
            <span className="text-xs text-muted-foreground">
              {fmt.pct(a.peakContext / a.contextWindow)} of{' '}
              {a.contextWindow >= 1_000_000 ? '1M' : '200k'} window
            </span>
          }
        />
        <Metric label="Cache hit rate" value={fmt.pct(a.cacheHitRate)}>
          <StackedBar
            total={1}
            segments={[{ value: a.cacheHitRate, color: 'var(--tok-cache-read)' }]}
          />
        </Metric>
        <Metric
          label="Tool calls"
          value={String(toolCount)}
          sub={
            <span className="text-xs text-muted-foreground">
              {a.inferenceCount} inference{a.inferenceCount === 1 ? '' : 's'}
            </span>
          }
        />
        <Metric
          label="Duration"
          value={fmt.ms(durationMs)}
          sub={
            <span className="text-xs text-muted-foreground">
              across {turnCount} turn{turnCount === 1 ? '' : 's'}
            </span>
          }
        />
      </div>
    </section>
  );
}

interface MetricProps {
  label: string;
  value: string;
  unit?: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}

function Metric({ label, value, unit, sub, children }: MetricProps) {
  return (
    <div className="flex min-h-[86px] flex-col gap-1 bg-background p-4">
      <div className="text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-2xl font-medium leading-[1.15] tracking-[-0.02em]">
        {value}
        {unit ? (
          <span className="ml-[3px] text-[13px] font-normal text-muted-foreground">{unit}</span>
        ) : null}
      </div>
      {sub}
      {children}
    </div>
  );
}

interface StackedBarSegment {
  value: number;
  color: string;
}

interface StackedBarProps {
  total: number;
  segments: readonly StackedBarSegment[];
}

function StackedBar({ total, segments }: StackedBarProps) {
  const safeTotal = Math.max(1, total);
  return (
    <div className="mt-1.5 flex h-2.5 overflow-hidden rounded bg-muted">
      {segments.map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: stacked-bar segments are positional and don't reorder
          key={i}
          className="block h-full"
          style={{
            width: `${(Math.max(0, seg.value) / safeTotal) * 100}%`,
            background: seg.color,
          }}
        />
      ))}
    </div>
  );
}

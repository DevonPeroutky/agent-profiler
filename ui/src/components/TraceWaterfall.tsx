import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SpanNode } from '@/types';
import { TokenWaterfall } from './TokenWaterfall';
import { TOKEN_CATS, TOKEN_CAT_ORDER } from './waterfall-tokens';
import {
  LEGEND_ITEMS,
  SpanRow,
  describeSpan,
  flattenSpanTree,
  type FlatRow,
} from './waterfall-span';

interface Props {
  roots: SpanNode[];
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
}

type WaterfallMode = 'duration' | 'tokens';

interface RowViewProps {
  rows: FlatRow[];
  collapsed: Set<string>;
  selectedSpanId: string | null;
  onToggle: (id: string) => void;
  onSelectSpan: (span: SpanNode) => void;
}

function DurationRows({
  rows,
  collapsed,
  selectedSpanId,
  onToggle,
  onSelectSpan,
}: RowViewProps) {
  const window = useMemo(() => {
    if (rows.length === 0) return { start: 0, size: 1 };
    const start = Math.min(...rows.map((r) => r.span.startMs));
    const end = Math.max(...rows.map((r) => r.span.endMs), start + 1);
    return { start, size: end - start };
  }, [rows]);

  return (
    <>
      {rows.map(({ span, depth, hasChildren }) => {
        const hasError = span.status?.code === 2;
        const { color: baseColor } = describeSpan(span);
        const color = hasError ? 'bg-destructive' : baseColor;
        const startPct = ((span.startMs - window.start) / window.size) * 100;
        const widthPct = Math.max(
          1.5,
          ((span.endMs - span.startMs) / window.size) * 100,
        );
        const endPct = startPct + widthPct;
        return (
          <SpanRow
            key={span.spanId}
            span={span}
            depth={depth}
            hasChildren={hasChildren}
            isSelected={span.spanId === selectedSpanId}
            isCollapsed={collapsed.has(span.spanId)}
            onToggle={() => onToggle(span.spanId)}
            onSelect={() => onSelectSpan(span)}
            labelLeftPct={endPct}
            bar={
              <>
                <div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  style={{ width: `${endPct}%`, backgroundColor: '#f4f4f5' }}
                />
                <div
                  className={cn('absolute inset-y-0 rounded-sm', color)}
                  style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                />
              </>
            }
          />
        );
      })}
    </>
  );
}

export function TraceWaterfall({
  roots,
  selectedSpanId,
  onSelectSpan,
}: Props) {
  const [mode, setMode] = useState<WaterfallMode>('duration');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const sortedRoots = useMemo(
    () => [...roots].sort((a, b) => a.startMs - b.startMs),
    [roots],
  );

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    for (const r of sortedRoots) flattenSpanTree(r, 0, collapsed, out);
    return out;
  }, [sortedRoots, collapsed]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (sortedRoots.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No spans in this turn.
      </div>
    );
  }

  const legendItems =
    mode === 'tokens'
      ? TOKEN_CAT_ORDER.map((k) => ({ label: TOKEN_CATS[k].label, cls: TOKEN_CATS[k].cls }))
      : LEGEND_ITEMS;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="max-h-[480px] overflow-auto px-4 py-3 font-mono text-xs">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans">
          {legendItems.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 shrink-0 rounded-sm', item.cls)} />
              <span className="text-[10px] text-muted-foreground">{item.label}</span>
            </div>
          ))}
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as WaterfallMode)}
            className="ml-auto"
          >
            <TabsList className="h-6 border border-border bg-zinc-200 p-0.5 dark:bg-zinc-800">
              <TabsTrigger
                value="duration"
                className="h-5 px-2 py-0 text-[10px]"
              >
                Duration
              </TabsTrigger>
              <TabsTrigger
                value="tokens"
                className="h-5 px-2 py-0 text-[10px]"
              >
                Tokens
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {mode === 'duration' ? (
          <DurationRows
            rows={rows}
            collapsed={collapsed}
            selectedSpanId={selectedSpanId}
            onToggle={toggle}
            onSelectSpan={onSelectSpan}
          />
        ) : (
          <TokenWaterfall
            rows={rows}
            collapsed={collapsed}
            selectedSpanId={selectedSpanId}
            onToggle={toggle}
            onSelectSpan={onSelectSpan}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

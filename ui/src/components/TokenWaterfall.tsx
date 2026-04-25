import { useMemo } from 'react';
import { formatTokens } from '@/lib/utils';
import type { SpanNode } from '@/types';
import { SpanRow, type FlatRow } from './waterfall-span';
import { computeTokenBars } from './waterfall-tokens';

interface Props {
  rows: FlatRow[];
  collapsed: Set<string>;
  selectedSpanId: string | null;
  onToggle: (id: string) => void;
  onSelectSpan: (span: SpanNode) => void;
}

export function TokenWaterfall({
  rows,
  collapsed,
  selectedSpanId,
  onToggle,
  onSelectSpan,
}: Props) {
  const bars = useMemo(() => computeTokenBars(rows, collapsed), [rows, collapsed]);

  return (
    <>
      {rows.map(({ span, depth, hasChildren }, i) => {
        const { prevPct, deltaPct, delta, segments } = bars[i];
        const labelLeftPct = delta > 0 ? prevPct + deltaPct : 100;
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
            labelLeftPct={labelLeftPct}
            labelSuffix={
              delta > 0 ? (
                <span className="ml-1 text-muted-foreground">
                  +{formatTokens(delta)}
                </span>
              ) : undefined
            }
            bar={
              delta > 0 ? (
                <>
                  <div
                    className="absolute inset-y-0 left-0 rounded-sm"
                    style={{ width: `${prevPct}%`, backgroundColor: '#f4f4f5' }}
                  />
                  <div
                    className="absolute inset-y-0 flex overflow-hidden rounded-sm"
                    style={{ left: `${prevPct}%`, width: `${deltaPct}%` }}
                  >
                    {segments.map((seg, j) => (
                      <span
                        key={j}
                        className={seg.cls}
                        style={{ width: `${seg.widthPct}%` }}
                      />
                    ))}
                  </div>
                </>
              ) : null
            }
          />
        );
      })}
    </>
  );
}

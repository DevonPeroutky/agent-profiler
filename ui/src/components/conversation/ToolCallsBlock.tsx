import { TraceWaterfall } from '@/components/TraceWaterfall';
import type { SpanNode } from '@/types';

interface Props {
  spans: SpanNode[];
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
}

export function ToolCallsBlock({ spans, selectedSpanId, onSelectSpan }: Props) {
  return (
    <div className="mx-4 my-2 overflow-hidden">
      <TraceWaterfall roots={spans} selectedSpanId={selectedSpanId} onSelectSpan={onSelectSpan} />
    </div>
  );
}

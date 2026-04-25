import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SpanNode } from '@/types';
import { MessageBlock } from './MessageBlock';
import { ToolCallsBlock } from './ToolCallsBlock';
import { buildTurnTimeline, type TurnTimelineEntry } from './transforms';

interface Props {
  turn: SpanNode;
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
  showReasoning: boolean;
}

type Segment =
  | { kind: 'tools'; spans: SpanNode[] }
  | { kind: 'message'; text: string }
  | { kind: 'reasoning'; text: string };

function groupSegments(entries: TurnTimelineEntry[]): Segment[] {
  const out: Segment[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (e.kind === 'tool') {
      if (last && last.kind === 'tools') last.spans.push(e.span);
      else out.push({ kind: 'tools', spans: [e.span] });
    } else if (e.kind === 'message') {
      out.push({ kind: 'message', text: e.text });
    } else {
      out.push({ kind: 'reasoning', text: e.text });
    }
  }
  return out;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.split('\n')[0].slice(0, 120);
  return (
    <div className="px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="italic">thinking</span>
        {!open && preview && (
          <span className="truncate opacity-70">· {preview}</span>
        )}
      </button>
      {open && (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {text}
        </pre>
      )}
    </div>
  );
}

export function TurnTimeline({
  turn,
  selectedSpanId,
  onSelectSpan,
  showReasoning,
}: Props) {
  const entries = useMemo(() => buildTurnTimeline(turn), [turn]);
  const segments = useMemo(() => {
    const grouped = groupSegments(entries);
    return showReasoning
      ? grouped
      : grouped.filter((s) => s.kind !== 'reasoning');
  }, [entries, showReasoning]);

  if (segments.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No activity in this turn.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'tools':
            return (
              <ToolCallsBlock
                key={`tools-${i}`}
                spans={seg.spans}
                selectedSpanId={selectedSpanId}
                onSelectSpan={onSelectSpan}
              />
            );
          case 'message':
            return <MessageBlock key={`msg-${i}`} text={seg.text} />;
          case 'reasoning':
            return <ReasoningBlock key={`think-${i}`} text={seg.text} />;
        }
      })}
    </div>
  );
}

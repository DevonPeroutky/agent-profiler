import { cn } from '@/lib/utils';
import type { SpanNode } from '@/types';
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MessageBlock } from './MessageBlock';
import { ToolCallsBlock } from './ToolCallsBlock';
import { type InferenceUsage, type TurnTimelineEntry, buildTurnTimeline } from './transforms';

interface Props {
  turn: SpanNode;
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
}

type Segment =
  | { kind: 'tools'; spans: SpanNode[] }
  | { kind: 'message'; text: string; usage: InferenceUsage }
  | { kind: 'reasoning'; text: string };

function groupSegments(entries: TurnTimelineEntry[]): Segment[] {
  const out: Segment[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (e.kind === 'tool') {
      if (last && last.kind === 'tools') last.spans.push(e.span);
      else out.push({ kind: 'tools', spans: [e.span] });
    } else if (e.kind === 'message') {
      out.push({ kind: 'message', text: e.text, usage: e.usage });
    } else {
      out.push({ kind: 'reasoning', text: e.text });
    }
  }
  return out;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text ? text.split('\n')[0].slice(0, 120) : 'encrypted';
  return (
    <div className="px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-200 ease-out',
            !open && '-rotate-90',
          )}
        />
        <span className="italic">thinking</span>
        {!open && preview && <span className="truncate opacity-70">· {preview}</span>}
      </button>
      {open &&
        (text ? (
          <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {text}
          </pre>
        ) : (
          <p className="mt-2 rounded bg-muted/40 px-3 py-2 font-mono text-[11px] italic text-muted-foreground/70">
            encrypted
          </p>
        ))}
    </div>
  );
}

export function TurnTimeline({ turn, selectedSpanId, onSelectSpan }: Props) {
  const entries = useMemo(() => buildTurnTimeline(turn), [turn]);
  const segments = useMemo(() => groupSegments(entries), [entries]);

  if (segments.length === 0) {
    return <div className="px-4 py-3 text-xs text-muted-foreground">No activity in this turn.</div>;
  }

  return (
    <div className="flex flex-col">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'tools':
            return (
              <ToolCallsBlock
                // biome-ignore lint/suspicious/noArrayIndexKey: turn timeline segments are positional and don't reorder
                key={`tools-${i}`}
                spans={seg.spans}
                selectedSpanId={selectedSpanId}
                onSelectSpan={onSelectSpan}
              />
            );
          case 'message':
            // biome-ignore lint/suspicious/noArrayIndexKey: turn timeline segments are positional and don't reorder
            return <MessageBlock key={`msg-${i}`} text={seg.text} usage={seg.usage} />;
          case 'reasoning':
            // biome-ignore lint/suspicious/noArrayIndexKey: turn timeline segments are positional and don't reorder
            return <ReasoningBlock key={`think-${i}`} text={seg.text} />;
        }
      })}
    </div>
  );
}

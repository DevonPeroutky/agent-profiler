import { cn } from '@/lib/utils';
import type { SpanNode } from '@/types';
import { fmt } from '../format';
import { toolTone } from './tool-tone';

interface Props {
  span: SpanNode;
  onSelect?: (span: SpanNode) => void;
}

function toolName(span: SpanNode): string {
  const a = span.attributes['agent_trace.tool.name'];
  return typeof a === 'string' && a ? a : span.name;
}

function toolSummary(span: SpanNode): string {
  const i = span.attributes['agent_trace.tool.input_summary'];
  if (typeof i !== 'string' || !i.trim()) return '';
  const flat = i.replace(/\s+/g, ' ').trim();
  // Strip leading JSON braces / quoted keys for readability when present.
  return flat.length > 140 ? flat.slice(0, 139) + '…' : flat;
}

export function ToolRow({ span, onSelect }: Props) {
  const name = toolName(span);
  const tone = toolTone(name);
  const summary = toolSummary(span);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(span)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-left transition-colors hover:bg-muted/40',
        tone.border,
      )}
    >
      <span
        className={cn(
          'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-1 text-[9px] font-bold',
          tone.badge,
        )}
      >
        {tone.glyph}
      </span>
      <span className={cn('shrink-0 font-mono text-[11px]', tone.headerText)}>
        {name}
      </span>
      {summary && (
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
          {summary}
        </span>
      )}
      {span.durationMs > 0 && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmt.ms(span.durationMs)}
        </span>
      )}
    </button>
  );
}

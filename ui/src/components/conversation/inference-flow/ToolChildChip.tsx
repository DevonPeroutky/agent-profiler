import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
  if (typeof i === 'string' && i.trim()) {
    const flat = i.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? flat.slice(0, 159) + '…' : flat;
  }
  return '';
}

export function ToolChildChip({ span, onSelect }: Props) {
  const name = toolName(span);
  const tone = toolTone(name);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(span);
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 transition-colors hover:bg-muted/40',
            tone.border,
          )}
        >
          <span
            className={cn(
              'inline-flex h-3 min-w-3 items-center justify-center rounded px-0.5 text-[8.5px] font-bold',
              tone.badge,
            )}
          >
            {tone.glyph}
          </span>
          <span className={cn('font-mono text-[10px]', tone.headerText)}>
            {name}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[320px] px-3 py-2">
        <div className="font-mono text-[11px] font-medium">{name}</div>
        {toolSummary(span) && (
          <div className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">
            {toolSummary(span)}
          </div>
        )}
        {span.durationMs > 0 && (
          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
            {fmt.ms(span.durationMs)}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

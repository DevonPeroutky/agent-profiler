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
  tools: SpanNode[];
  onSelect?: (span: SpanNode) => void;
  max?: number;
}

function toolName(span: SpanNode): string {
  const a = span.attributes['agent_trace.tool.name'];
  return typeof a === 'string' && a ? a : span.name;
}

function toolSummary(span: SpanNode): string {
  const i = span.attributes['agent_trace.tool.input_summary'];
  if (typeof i === 'string' && i.trim()) {
    const flat = i.replace(/\s+/g, ' ').trim();
    return flat.length > 120 ? flat.slice(0, 119) + '…' : flat;
  }
  return '';
}

export function ToolChipStrip({ tools, onSelect, max = 6 }: Props) {
  if (tools.length === 0) return null;
  const visible = tools.slice(0, max);
  const overflow = tools.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1 py-0.5">
      <span
        aria-hidden="true"
        className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/50"
      >
        ↳ fed
      </span>
      {visible.map((span) => {
        const name = toolName(span);
        const tone = toolTone(name);
        return (
          <Tooltip key={span.spanId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect?.(span)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:bg-muted/60',
                  tone.border,
                  tone.headerText,
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
                <span>{name}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[320px] px-3 py-2">
              <div className="font-mono text-[11px] font-medium">{name}</div>
              {toolSummary(span) && (
                <div className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">
                  {toolSummary(span)}
                </div>
              )}
              <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                {span.durationMs > 0 ? fmt.ms(span.durationMs) : ''}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <span className="font-mono text-[10px] text-muted-foreground/70">
          +{overflow} more
        </span>
      )}
    </div>
  );
}

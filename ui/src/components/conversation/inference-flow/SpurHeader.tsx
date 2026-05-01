import type { SpanNode } from '@/types';
import type { Dispatch } from './transforms';

interface Props {
  dispatch: Dispatch;
  onSelectSpan?: (span: SpanNode) => void;
}

export function SpurHeader({ dispatch, onSelectSpan }: Props) {
  const subtype = dispatch.subagentType ?? '(unknown)';
  return (
    <button
      type="button"
      onClick={() => onSelectSpan?.(dispatch.dispatchToolSpan)}
      className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-violet-500/[0.08]"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-violet-500">
        {dispatch.toolName}
      </span>
      <span className="truncate font-mono text-[11px] text-foreground">
        {subtype}
      </span>
      {dispatch.description && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          · {dispatch.description}
        </span>
      )}
    </button>
  );
}

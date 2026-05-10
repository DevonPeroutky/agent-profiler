import { cn } from '@/lib/utils';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0';

export function UserPromptNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'userPromptNode' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  const { promptLabel, isSlashCommand, span } = data;
  const badgeLabel = isSlashCommand ? 'slash' : 'user';
  const label = promptLabel ?? (isSlashCommand ? '/(no command)' : '(no prompt)');

  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} id="top" className={HANDLE_CLASSES} />
      <Handle type="target" position={Position.Left} id="left" className={HANDLE_CLASSES} />
      <button
        type="button"
        onClick={() => onSelectSpan?.(span)}
        className={cn(
          'flex w-[320px] flex-col gap-1.5 rounded-md border-2 px-3 py-2 text-left shadow-sm transition-colors',
          isSlashCommand
            ? 'border-violet-500/60 bg-violet-500/[0.12] hover:bg-violet-500/[0.18]'
            : 'border-sky-500/60 bg-sky-500/[0.10] hover:bg-sky-500/[0.16]',
        )}
      >
        <span
          className={cn(
            'self-start rounded border px-1 font-mono text-[10px] uppercase tracking-[0.06em]',
            isSlashCommand
              ? 'border-violet-500/50 bg-violet-500/[0.15] text-violet-400'
              : 'border-sky-500/50 bg-sky-500/[0.15] text-sky-400',
          )}
        >
          {badgeLabel}
        </span>
        <span className="line-clamp-6 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
          {label}
        </span>
      </button>
      <Handle type="source" position={Position.Bottom} id="bottom" className={HANDLE_CLASSES} />
      <Handle type="source" position={Position.Right} id="right" className={HANDLE_CLASSES} />
    </div>
  );
}

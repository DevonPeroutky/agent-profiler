import { type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { InferenceFlowNode } from '../types';

export function SubagentGroupNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'subagentGroup' }>>) {
  const dispatchKind = data.dispatch.toolName;
  const subtype = data.dispatch.subagentType ?? '';
  const label = subtype ? `${dispatchKind} · ${subtype}` : dispatchKind;
  return (
    <div
      className={cn(
        'pointer-events-none relative h-full w-full rounded-lg border border-dashed border-violet-500/40 bg-violet-500/[0.06]',
      )}
    >
      <div className="absolute -top-2 left-3 rounded bg-background px-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-violet-500/80">
        {label}
      </div>
    </div>
  );
}

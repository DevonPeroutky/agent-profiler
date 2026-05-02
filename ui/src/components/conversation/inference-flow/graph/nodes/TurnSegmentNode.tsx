import { Handle, type NodeProps, Position } from '@xyflow/react';
import { InferenceNodeCard } from '../../InferenceNodeCard';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0';

export function TurnSegmentNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'turnSegment' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  const { isFirstSegment, turnNumber, inferences, endsInDispatch } = data;

  return (
    <div className="flex w-[320px] flex-col rounded-md border border-border bg-background shadow-sm">
      <Handle type="target" position={Position.Top} id="top" className={HANDLE_CLASSES} />
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-[10px]">
        <span className="rounded bg-muted px-1 font-mono uppercase tracking-[0.06em] text-muted-foreground">
          turn {turnNumber ?? '—'}
          {isFirstSegment ? '' : ' · cont.'}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {inferences.map((inf) => (
          <InferenceNodeCard key={inf.id} node={inf} onSelect={onSelectSpan} />
        ))}
      </div>
      {endsInDispatch && (
        <Handle type="source" position={Position.Right} id="right" className={HANDLE_CLASSES} />
      )}
      <Handle type="source" position={Position.Bottom} id="bottom" className={HANDLE_CLASSES} />
    </div>
  );
}

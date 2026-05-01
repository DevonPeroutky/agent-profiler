import { Handle, Position, type NodeProps } from '@xyflow/react';
import { SpurHeader } from '../../SpurHeader';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-2 !w-2 !border-0 !bg-violet-500/60';

export function SubagentHeaderNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'subagentHeader' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  return (
    <div className="w-[280px] rounded-md border border-violet-500/40 bg-violet-500/[0.06] px-2 py-1.5">
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className={HANDLE_CLASSES}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className={HANDLE_CLASSES}
      />
      <SpurHeader dispatch={data.dispatch} onSelectSpan={onSelectSpan} />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className={HANDLE_CLASSES}
      />
    </div>
  );
}

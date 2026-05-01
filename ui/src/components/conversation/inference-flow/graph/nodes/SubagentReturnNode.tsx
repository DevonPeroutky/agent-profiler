import { Handle, Position, type NodeProps } from '@xyflow/react';
import { SpurFooter } from '../../SpurFooter';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-2 !w-2 !border-0 !bg-violet-500/60';

export function SubagentReturnNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'subagentReturn' }>>) {
  return (
    <div className="w-[280px] rounded-md border border-dashed border-violet-500/40 bg-violet-500/[0.04] px-2 pb-1 pt-0.5">
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className={HANDLE_CLASSES}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className={HANDLE_CLASSES}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className={HANDLE_CLASSES}
      />
      <SpurFooter dispatch={data.dispatch} />
    </div>
  );
}

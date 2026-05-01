import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { InferenceNodeCard } from '../../InferenceNodeCard';
import { ToolChildChip } from '../../ToolChildChip';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode as InferenceFlowNodeType } from '../types';

const HANDLE_CLASSES = '!h-2 !w-2 !border-0 !bg-foreground/30';

export function InferenceFlowNode({
  data,
}: NodeProps<Extract<InferenceFlowNodeType, { type: 'inference' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  const { node, tone } = data;
  const demoted = tone === 'subagent' || tone === 'unattached';
  const tools = node.emittedTools;

  return (
    <div
      className={cn(
        'flex w-[280px] flex-col gap-1.5 rounded-md border bg-background p-2',
        tone === 'subagent' && 'border-violet-500/40 bg-violet-500/[0.04]',
        tone === 'unattached' && 'border-amber-500/40 bg-amber-500/[0.04]',
        tone === 'default' && 'border-border',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className={HANDLE_CLASSES}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className={HANDLE_CLASSES}
      />
      <InferenceNodeCard
        node={node}
        demoted={demoted}
        onSelect={onSelectSpan}
      />
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-2">
          {tools.map((tool) => (
            <ToolChildChip
              key={tool.spanId}
              span={tool}
              onSelect={onSelectSpan}
            />
          ))}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className={HANDLE_CLASSES}
      />
    </div>
  );
}

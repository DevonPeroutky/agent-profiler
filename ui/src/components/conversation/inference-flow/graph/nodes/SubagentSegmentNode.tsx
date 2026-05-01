import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { InferenceNodeCard } from '../../InferenceNodeCard';
import { ToolChildChip } from '../../ToolChildChip';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-2 !w-2 !border-0 !bg-violet-500/40';

export function SubagentSegmentNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'subagentSegment' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  const {
    isFirstOfTurn,
    inferences,
    endsInDispatch,
    dispatch,
    tone,
  } = data;

  const isUnattached = tone === 'unattached';
  const headerLabel = (() => {
    if (isFirstOfTurn && dispatch) {
      const subtype = dispatch.subagentType ?? '';
      return subtype
        ? `${dispatch.toolName} · ${subtype}`
        : dispatch.toolName;
    }
    if (isFirstOfTurn && isUnattached) return 'unattached';
    return 'subagent · cont.';
  })();

  return (
    <div
      className={cn(
        'flex w-[320px] flex-col rounded-md border bg-background shadow-sm',
        isUnattached
          ? 'border-dashed border-amber-500/50 bg-amber-500/[0.03]'
          : 'border-dashed border-violet-500/50 bg-violet-500/[0.03]',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className={HANDLE_CLASSES}
      />
      <div
        className={cn(
          'flex items-center gap-2 border-b px-2.5 py-1.5 text-[10px]',
          isUnattached ? 'border-amber-500/30' : 'border-violet-500/30',
        )}
      >
        <span
          className={cn(
            'rounded px-1 font-mono uppercase tracking-[0.06em]',
            isUnattached ? 'text-amber-600' : 'text-violet-600',
          )}
        >
          {headerLabel}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {inferences.map((inf) => (
          <div key={inf.id} className="flex flex-col gap-1">
            <InferenceNodeCard
              node={inf}
              demoted
              onSelect={onSelectSpan}
            />
            {inf.emittedTools.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-2">
                {inf.emittedTools.map((tool) => (
                  <ToolChildChip
                    key={tool.spanId}
                    span={tool}
                    onSelect={onSelectSpan}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {endsInDispatch && (
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          className={HANDLE_CLASSES}
        />
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

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { InferenceNodeCard } from '../../InferenceNodeCard';
import { ToolChildChip } from '../../ToolChildChip';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-2 !w-2 !border-0 !bg-foreground/30';

export function TurnSegmentNode({
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'turnSegment' }>>) {
  const { onSelectSpan } = useInferenceGraphContext();
  const {
    isFirstOfTurn,
    turnNumber,
    promptLabel,
    inferences,
    endsInDispatch,
  } = data;

  return (
    <div className="flex w-[320px] flex-col rounded-md border border-border bg-background shadow-sm">
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className={HANDLE_CLASSES}
      />
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-[10px]',
        )}
      >
        {isFirstOfTurn ? (
          <>
            <span className="rounded bg-muted px-1 font-mono uppercase tracking-[0.06em] text-muted-foreground">
              turn {turnNumber ?? '—'}
            </span>
            {promptLabel && (
              <span className="truncate text-foreground">{promptLabel}</span>
            )}
          </>
        ) : (
          <span className="font-mono uppercase tracking-[0.06em] text-muted-foreground">
            turn {turnNumber ?? '—'} · cont.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 p-2">
        {inferences.map((inf) => (
          <div key={inf.id} className="flex flex-col gap-1">
            <InferenceNodeCard node={inf} onSelect={onSelectSpan} />
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

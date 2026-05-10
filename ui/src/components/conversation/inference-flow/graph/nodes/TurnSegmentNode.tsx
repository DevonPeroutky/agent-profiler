import { Handle, type NodeProps, Position } from '@xyflow/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmt } from '../../../format';
import { InferenceNodeCard } from '../../InferenceNodeCard';
import { type InferenceNode, type InferenceTokens, totalTokens } from '../../transforms';
import { useInferenceGraphContext } from '../context';
import type { InferenceFlowNode } from '../types';

const HANDLE_CLASSES = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0';

function summarize(inferences: InferenceNode[]): { count: number; tokens: number; durationMs: number } {
  let durationMs = 0;
  const tokens: InferenceTokens = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  for (const inf of inferences) {
    if (inf.isSynthetic) continue;
    durationMs += inf.durationMs;
    tokens.input += inf.tokens.input;
    tokens.cacheRead += inf.tokens.cacheRead;
    tokens.cacheCreation += inf.tokens.cacheCreation;
    tokens.output += inf.tokens.output;
  }
  return { count: inferences.filter((i) => !i.isSynthetic).length, tokens: totalTokens(tokens), durationMs };
}

export function TurnSegmentNode({
  id,
  data,
}: NodeProps<Extract<InferenceFlowNode, { type: 'turnSegment' }>>) {
  const { onSelectSpan, collapsedSegmentIds, toggleSegmentCollapsed } = useInferenceGraphContext();
  const { isFirstSegment, turnNumber, inferences } = data;

  const isCollapsed = collapsedSegmentIds.has(id);
  const canCollapse = inferences.length > 0;
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
  const summary = summarize(inferences);

  const HeaderInner = (
    <span className="flex items-center gap-1 rounded bg-muted px-1 font-mono uppercase tracking-[0.06em] text-muted-foreground">
      {canCollapse && <ChevronIcon className="h-3 w-3" aria-hidden="true" />}
      turn {turnNumber ?? '—'}
      {isFirstSegment ? '' : ' · cont.'}
    </span>
  );

  return (
    <div className="flex w-[320px] flex-col rounded-md border border-border bg-background shadow-sm">
      <Handle type="target" position={Position.Top} id="top" className={HANDLE_CLASSES} />
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-[10px]">
        {canCollapse ? (
          <button
            type="button"
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              toggleSegmentCollapsed(id);
            }}
            className="flex items-center hover:opacity-80"
          >
            {HeaderInner}
          </button>
        ) : (
          HeaderInner
        )}
      </div>
      {isCollapsed ? (
        <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">
          {`${summary.count} inf · ${fmt.n(summary.tokens)} tok · ${fmt.ms(summary.durationMs)}`}
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2">
          {inferences.map((inf) => (
            <InferenceNodeCard key={inf.id} node={inf} onSelect={onSelectSpan} />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} id="right" className={HANDLE_CLASSES} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={HANDLE_CLASSES} />
    </div>
  );
}

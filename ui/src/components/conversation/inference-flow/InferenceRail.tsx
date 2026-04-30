import { Fragment } from 'react';
import { CornerUpLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SpanNode } from '@/types';
import { fmt } from '../format';
import { InferenceNodeCard } from './InferenceNodeCard';
import { ToolChipStrip } from './ToolChipStrip';
import { ToolRow } from './ToolRow';
import {
  totalTokens,
  type Dispatch,
  type InferenceFlowModel,
  type InferenceNode,
} from './transforms';

interface RailProps {
  branchId: string;
  model: InferenceFlowModel;
  depth: number;
  onSelectSpan?: (span: SpanNode) => void;
}

const NODE_WIDTH_MAIN = 'w-[260px]';

export function InferenceRail({
  branchId,
  model,
  depth,
  onSelectSpan,
}: RailProps) {
  const nodes = model.branches.get(branchId);
  if (!nodes || nodes.length === 0) {
    return (
      <div className="rounded border border-dashed border-border px-3 py-2 text-[11px] italic text-muted-foreground">
        No inferences in this branch.
      </div>
    );
  }
  if (branchId === 'main') {
    return (
      <MainRail nodes={nodes} model={model} depth={depth} onSelectSpan={onSelectSpan} />
    );
  }
  return <SpurBody nodes={nodes} model={model} depth={depth} onSelectSpan={onSelectSpan} />;
}

function MainRail({
  nodes,
  model,
  depth,
  onSelectSpan,
}: {
  nodes: InferenceNode[];
  model: InferenceFlowModel;
  depth: number;
  onSelectSpan?: (span: SpanNode) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {nodes.map((node, idx) => {
        const hasNext = idx < nodes.length - 1;
        const hasDispatches = node.dispatches.length > 0;
        return (
          <Fragment key={node.id}>
            {idx > 0 && node.precedingTools.length > 0 && (
              <div className="pl-4">
                <ToolChipStrip
                  tools={node.precedingTools}
                  onSelect={onSelectSpan}
                />
              </div>
            )}
            <div className="relative flex items-start gap-4">
              <div
                aria-hidden="true"
                className={cn(
                  'absolute left-2 w-px bg-border',
                  idx === 0 ? 'top-3' : '-top-2',
                  idx === nodes.length - 1 ? 'bottom-1/2' : 'bottom-0',
                )}
              />
              <span
                aria-hidden="true"
                className="absolute left-[5px] top-3 h-1.5 w-1.5 rounded-full bg-foreground/40"
              />
              <div className={cn('shrink-0 pl-4', NODE_WIDTH_MAIN)}>
                <InferenceNodeCard node={node} onSelect={onSelectSpan} />
              </div>
              {hasDispatches && (
                <div className="relative flex min-w-0 flex-1 flex-col">
                  {/* Branch line: from main rail across to spurs at the top */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -left-4 right-0 top-2 h-px bg-violet-500/40"
                  />
                  <div className="flex items-stretch gap-3 overflow-x-auto pb-1 pt-4">
                    {node.dispatches.map((d) => (
                      <Spur
                        key={d.childBranchId}
                        dispatch={d}
                        model={model}
                        depth={depth + 1}
                        onSelectSpan={onSelectSpan}
                        sideBySide
                        showReturnConnector={hasNext}
                      />
                    ))}
                  </div>
                  {/* Return line: bridge bottom-of-spur(s) back to the main
                      rail beneath this row, so the next main-rail node is
                      visually reached from above. */}
                  {hasNext && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute -left-4 right-0 bottom-0 h-px bg-violet-500/40"
                    />
                  )}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function SpurBody({
  nodes,
  model,
  depth,
  onSelectSpan,
}: {
  nodes: InferenceNode[];
  model: InferenceFlowModel;
  depth: number;
  onSelectSpan?: (span: SpanNode) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {nodes.map((node, idx) => (
        <Fragment key={node.id}>
          {idx > 0 &&
            node.precedingTools.map((tool) => (
              <ToolRow
                key={tool.spanId}
                span={tool}
                onSelect={onSelectSpan}
              />
            ))}
          <InferenceNodeCard node={node} demoted onSelect={onSelectSpan} />
          {node.dispatches.length > 0 && (
            <div className="flex flex-col gap-1.5 pl-3">
              {node.dispatches.map((d) => (
                <Spur
                  key={d.childBranchId}
                  dispatch={d}
                  model={model}
                  depth={depth + 1}
                  onSelectSpan={onSelectSpan}
                />
              ))}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function Spur({
  dispatch,
  model,
  depth,
  onSelectSpan,
  sideBySide,
  showReturnConnector,
}: {
  dispatch: Dispatch;
  model: InferenceFlowModel;
  depth: number;
  onSelectSpan?: (span: SpanNode) => void;
  sideBySide?: boolean;
  showReturnConnector?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative flex shrink-0 flex-col gap-2 rounded-md border border-dashed border-violet-500/30 bg-violet-500/[0.04] p-2',
        sideBySide ? 'min-w-[260px]' : 'w-full',
      )}
    >
      {/* Branch-in connector: top edge of card up to the parent's branch line */}
      {sideBySide && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-2 left-3 h-2 w-px bg-violet-500/40"
        />
      )}
      <SpurHeader dispatch={dispatch} onSelectSpan={onSelectSpan} />
      <InferenceRail
        branchId={dispatch.childBranchId}
        model={model}
        depth={depth}
        onSelectSpan={onSelectSpan}
      />
      <SpurFooter dispatch={dispatch} />
      {/* Return connector: bottom edge of card down to the row's return line */}
      {sideBySide && showReturnConnector && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-2 left-3 h-2 w-px bg-violet-500/40"
        />
      )}
    </div>
  );
}

function SpurHeader({
  dispatch,
  onSelectSpan,
}: {
  dispatch: Dispatch;
  onSelectSpan?: (span: SpanNode) => void;
}) {
  const subtype = dispatch.subagentType ?? '(unknown)';
  return (
    <button
      type="button"
      onClick={() => onSelectSpan?.(dispatch.dispatchToolSpan)}
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-violet-500/[0.08]"
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

function SpurFooter({ dispatch }: { dispatch: Dispatch }) {
  const total = totalTokens(dispatch.subagentTokens);
  return (
    <div className="flex items-center gap-1.5 border-t border-violet-500/20 pt-1.5 text-[10px] text-violet-500/80">
      <CornerUpLeft aria-hidden="true" className="h-3 w-3" />
      <span className="font-mono uppercase tracking-[0.06em]">return</span>
      {dispatch.requestCount > 0 && (
        <span className="font-mono text-muted-foreground/70">
          · {dispatch.requestCount} call{dispatch.requestCount === 1 ? '' : 's'}
        </span>
      )}
      {total > 0 && (
        <span className="ml-auto font-mono text-muted-foreground/70">
          {fmt.n(total)} tok
        </span>
      )}
    </div>
  );
}

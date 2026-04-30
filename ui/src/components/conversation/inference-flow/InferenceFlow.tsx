import { useMemo } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ConversationSummary, SpanNode } from '@/types';
import { InferenceFlowHeader } from './InferenceFlowHeader';
import { InferenceRail } from './InferenceRail';
import { buildInferenceFlowModel } from './transforms';

interface Props {
  conversation: ConversationSummary;
  onSelectSpan?: (span: SpanNode) => void;
}

export function InferenceFlow({ conversation, onSelectSpan }: Props) {
  const model = useMemo(
    () => buildInferenceFlowModel(conversation),
    [conversation],
  );

  const mainCount = model.branches.get('main')?.length ?? 0;
  const hasUnattached = model.unattachedBranchIds.length > 0;

  if (mainCount === 0 && !hasUnattached) {
    return (
      <section>
        <InferenceFlowHeader model={model} />
        <div className="rounded-lg border border-border bg-background px-6 py-8 text-xs text-muted-foreground">
          No inferences captured for this conversation yet.
        </div>
      </section>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <section>
        <InferenceFlowHeader model={model} />
        <div className="rounded-lg border border-border bg-background p-3">
          {mainCount > 0 && (
            <InferenceRail
              branchId="main"
              model={model}
              depth={0}
              onSelectSpan={onSelectSpan}
            />
          )}
          {hasUnattached && (
            <div className="mt-4 border-t border-dashed border-border pt-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
                Unattached subagents
              </div>
              <div className="flex flex-col gap-3">
                {model.unattachedBranchIds.map((bid) => (
                  <div
                    key={bid}
                    className="rounded-md border border-dashed border-amber-500/30 bg-amber-500/[0.04] p-2"
                  >
                    <InferenceRail
                      branchId={bid}
                      model={model}
                      depth={1}
                      onSelectSpan={onSelectSpan}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

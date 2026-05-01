import { useMemo } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ConversationSummary, SpanNode } from '@/types';
import { InferenceFlowHeader } from './InferenceFlowHeader';
import { InferenceGraph } from './graph/InferenceGraph';
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
        <div className="h-[calc(100vh-280px)] min-h-[640px] overflow-hidden rounded-lg border border-border bg-background">
          <InferenceGraph
            model={model}
            conversation={conversation}
            onSelectSpan={onSelectSpan}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}

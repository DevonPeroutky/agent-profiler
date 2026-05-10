import type { ConversationSummary, SpanNode } from '@/types';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InferenceFlowModel } from '../transforms';
import { buildGraph } from './buildGraph';
import { InferenceGraphContext } from './context';
import { styleEdges } from './edges';
import { layoutGraph } from './layoutGraph';
import { SubagentSegmentNode } from './nodes/SubagentSegmentNode';
import { TurnSegmentNode } from './nodes/TurnSegmentNode';
import { UserPromptNode } from './nodes/UserPromptNode';
import type { InferenceFlowNode } from './types';

const nodeTypes = {
  turnSegment: TurnSegmentNode,
  subagentSegment: SubagentSegmentNode,
  userPromptNode: UserPromptNode,
};

interface Props {
  model: InferenceFlowModel;
  conversation: ConversationSummary;
  onSelectSpan?: (span: SpanNode) => void;
}

const FIT_VIEW_OPTIONS = { padding: 0.15, maxZoom: 1 } as const;

// ReactFlow's `fitView` prop fires once during mount, often before nodes have
// been measured — the result is the wrong zoom. Refit after the new graph is
// committed and painted. We fit twice (next frame + 80ms) because some nodes
// only finalize their height after the second pass (long-prompt cards wrap
// based on container width, which depends on layout).
function FitOnGraphChange({ depKey }: { depKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const fitOnce = () => fitView(FIT_VIEW_OPTIONS);
    const rafId = requestAnimationFrame(fitOnce);
    const timeoutId = window.setTimeout(fitOnce, 80);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [depKey, fitView]);
  return null;
}

// Default-collapse every segment. A collapsed segment shows a one-line
// summary (count · tokens · duration), so the full conversation reads as a
// compact overview at default zoom. Users click any segment header to expand
// its inference cards.
function computeInitialCollapsed(nodes: InferenceFlowNode[]): Set<string> {
  const collapsed = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'turnSegment' || node.type === 'subagentSegment') {
      collapsed.add(node.id);
    }
  }
  return collapsed;
}

export function InferenceGraph({ model, conversation, onSelectSpan }: Props) {
  const [collapsedSegmentIds, setCollapsedSegmentIds] = useState<Set<string>>(() =>
    computeInitialCollapsed(buildGraph(model, conversation).nodes),
  );

  // Reset to the default-collapsed shape when the user navigates to a different
  // conversation. Live updates within the same conversation (e.g. token polling)
  // preserve any manual expand/collapse the user has applied.
  useEffect(() => {
    setCollapsedSegmentIds(computeInitialCollapsed(buildGraph(model, conversation).nodes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.sessionId]);

  const toggleSegmentCollapsed = useCallback((segmentId: string) => {
    setCollapsedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  }, []);

  const { nodes, edges } = useMemo(() => {
    const built = buildGraph(model, conversation);
    const laid = layoutGraph(built.nodes, built.edges, model, conversation, collapsedSegmentIds);
    return { nodes: laid.nodes, edges: styleEdges(laid.edges) };
  }, [model, conversation, collapsedSegmentIds]);

  const ctx = useMemo(
    () => ({ onSelectSpan, collapsedSegmentIds, toggleSegmentCollapsed }),
    [onSelectSpan, collapsedSegmentIds, toggleSegmentCollapsed],
  );

  return (
    <InferenceGraphContext.Provider value={ctx}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable position="bottom-right" />
          <FitOnGraphChange depKey={conversation.sessionId} />
        </ReactFlow>
      </ReactFlowProvider>
    </InferenceGraphContext.Provider>
  );
}

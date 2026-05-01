import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { SpanNode } from '@/types';
import type { InferenceFlowModel } from '../transforms';
import { buildGraph } from './buildGraph';
import { InferenceGraphContext } from './context';
import { styleEdges } from './edges';
import { layoutGraph } from './layoutGraph';
import { InferenceFlowNode } from './nodes/InferenceFlowNode';
import { SubagentGroupNode } from './nodes/SubagentGroupNode';
import { SubagentHeaderNode } from './nodes/SubagentHeaderNode';
import { SubagentReturnNode } from './nodes/SubagentReturnNode';

const nodeTypes = {
  inference: InferenceFlowNode,
  subagentGroup: SubagentGroupNode,
  subagentHeader: SubagentHeaderNode,
  subagentReturn: SubagentReturnNode,
};

interface Props {
  model: InferenceFlowModel;
  onSelectSpan?: (span: SpanNode) => void;
}

export function InferenceGraph({ model, onSelectSpan }: Props) {
  const { nodes, edges } = useMemo(() => {
    const built = buildGraph(model);
    const laid = layoutGraph(built.nodes, built.edges, model);
    return { nodes: laid.nodes, edges: styleEdges(laid.edges) };
  }, [model]);

  const ctx = useMemo(() => ({ onSelectSpan }), [onSelectSpan]);

  return (
    <InferenceGraphContext.Provider value={ctx}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </InferenceGraphContext.Provider>
  );
}

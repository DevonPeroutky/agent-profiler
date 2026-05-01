import type { Edge, Node } from '@xyflow/react';
import type { Dispatch, InferenceNode } from '../transforms';

export type FlowTone = 'default' | 'subagent' | 'unattached';

export type EdgeTone = 'default' | 'subagent' | 'dispatch' | 'return';

export interface InferenceNodeData extends Record<string, unknown> {
  node: InferenceNode;
  tone: FlowTone;
}

export interface SubagentBoundaryData extends Record<string, unknown> {
  dispatch: Dispatch;
  tone: FlowTone;
}

export interface SubagentGroupData extends Record<string, unknown> {
  dispatch: Dispatch;
  depth: number;
}

export interface FlowEdgeData extends Record<string, unknown> {
  tone: EdgeTone;
}

export type InferenceFlowNode =
  | Node<InferenceNodeData, 'inference'>
  | Node<SubagentBoundaryData, 'subagentHeader'>
  | Node<SubagentBoundaryData, 'subagentReturn'>
  | Node<SubagentGroupData, 'subagentGroup'>;

export type InferenceFlowEdge = Edge<FlowEdgeData>;

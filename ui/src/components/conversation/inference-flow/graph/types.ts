import type { Edge, Node } from '@xyflow/react';
import type { Dispatch, InferenceNode } from '../transforms';

export type FlowTone = 'default' | 'subagent' | 'unattached';

export type EdgeTone = 'default' | 'subagent' | 'dispatch' | 'return';

export interface SegmentData extends Record<string, unknown> {
  turnNumber: number | null;
  segmentIndex: number;
  isFirstOfTurn: boolean;
  promptLabel: string | null;
  inferences: InferenceNode[];
  endsInDispatch: boolean;
  tone: FlowTone;
}

export interface SubagentSegmentData extends SegmentData {
  // Set on the first segment of a subagent bundle (carries dispatch metadata
  // for the header label like "Skill · Explore"). Undefined on continuation
  // segments inside the same bundle.
  dispatch?: Dispatch;
}

export interface FlowEdgeData extends Record<string, unknown> {
  tone: EdgeTone;
}

export type InferenceFlowNode =
  | Node<SegmentData, 'turnSegment'>
  | Node<SubagentSegmentData, 'subagentSegment'>;

export type InferenceFlowEdge = Edge<FlowEdgeData>;

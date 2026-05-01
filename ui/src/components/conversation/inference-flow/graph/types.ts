import type { Edge, Node } from '@xyflow/react';
import type { SpanNode } from '@/types';
import type { Dispatch, InferenceNode } from '../transforms';

export type FlowTone = 'default' | 'subagent' | 'unattached';

export type EdgeTone = 'default' | 'subagent' | 'dispatch' | 'return';

export interface SegmentData extends Record<string, unknown> {
  turnNumber: number | null;
  segmentIndex: number;
  isFirstSegment: boolean;
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

export interface UserPromptData extends Record<string, unknown> {
  turnNumber: number | null;
  promptLabel: string | null;
  isSlashCommand: boolean;
  span: SpanNode;
}

export interface FlowEdgeData extends Record<string, unknown> {
  tone: EdgeTone;
}

export type InferenceFlowNode =
  | Node<SegmentData, 'turnSegment'>
  | Node<SubagentSegmentData, 'subagentSegment'>
  | Node<UserPromptData, 'userPromptNode'>;

export type InferenceFlowEdge = Edge<FlowEdgeData>;

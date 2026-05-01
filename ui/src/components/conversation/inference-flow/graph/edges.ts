import { MarkerType, type EdgeMarker } from '@xyflow/react';
import type { EdgeTone, InferenceFlowEdge } from './types';

const STROKE_DEFAULT = 'rgba(148, 163, 184, 0.6)';
const STROKE_VIOLET = 'rgba(139, 92, 246, 0.7)';

const STYLE_BY_TONE: Record<
  EdgeTone,
  { stroke: string; dashed?: boolean }
> = {
  default: { stroke: STROKE_DEFAULT },
  subagent: { stroke: STROKE_VIOLET },
  dispatch: { stroke: STROKE_VIOLET },
  return: { stroke: STROKE_VIOLET, dashed: true },
};

function marker(stroke: string): EdgeMarker {
  return {
    type: MarkerType.ArrowClosed,
    color: stroke,
    width: 16,
    height: 16,
  };
}

export function styleEdges(edges: InferenceFlowEdge[]): InferenceFlowEdge[] {
  return edges.map((edge) => {
    const tone: EdgeTone = edge.data?.tone ?? 'default';
    const { stroke, dashed } = STYLE_BY_TONE[tone];
    return {
      ...edge,
      style: {
        stroke,
        strokeWidth: 1.5,
        ...(dashed ? { strokeDasharray: '5 5' } : {}),
      },
      markerEnd: marker(stroke),
    };
  });
}

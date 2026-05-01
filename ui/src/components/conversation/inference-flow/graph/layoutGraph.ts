import { Position } from '@xyflow/react';
import type { InferenceFlowEdge, InferenceFlowNode } from './types';
import type { InferenceFlowModel, InferenceNode } from '../transforms';

const SEGMENT_WIDTH = 320;
const HEADER_HEIGHT = 28;
const SEGMENT_PADDING_X = 8;
const SEGMENT_PADDING_TOP = 8;
const SEGMENT_PADDING_BOTTOM = 8;

const INFERENCE_BLOCK_HEIGHT = 64;
const INFERENCE_TOOLS_ROW_HEIGHT = 22;
const INFERENCE_TOOLS_GAP = 4;
const INFERENCE_TOOLS_PER_ROW = 3;
const INNER_GAP = 8;

const RAIL_GAP = 32;
const HORIZONTAL_GAP = 80;
const TOP_LEVEL_MARGIN_X = 32;
const TOP_LEVEL_MARGIN_Y = 32;
const UNATTACHED_GAP = 80;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function inferenceBlockHeight(inf: InferenceNode): number {
  const base = INFERENCE_BLOCK_HEIGHT;
  const toolCount = inf.emittedTools.length;
  if (toolCount === 0) return base;
  const rows = Math.ceil(toolCount / INFERENCE_TOOLS_PER_ROW);
  return base + rows * INFERENCE_TOOLS_ROW_HEIGHT + INFERENCE_TOOLS_GAP;
}

function segmentHeight(inferences: InferenceNode[]): number {
  if (inferences.length === 0) {
    return HEADER_HEIGHT + SEGMENT_PADDING_TOP + SEGMENT_PADDING_BOTTOM;
  }
  const blocks = inferences.reduce((s, i) => s + inferenceBlockHeight(i), 0);
  const gaps = (inferences.length - 1) * INNER_GAP;
  return (
    HEADER_HEIGHT + SEGMENT_PADDING_TOP + blocks + gaps + SEGMENT_PADDING_BOTTOM
  );
}

// Lay out a chain of segments: each segment placed vertically; if a segment
// ends in a dispatch, the dispatched subagent chain is laid out to its right
// at the same Y. Returns the bounding height (from offsetY to bottom of last
// segment) so the caller can advance its outer cursor.
function layoutSegmentChain(
  branchKey: string,
  segmentsCount: number,
  inferencesPerSegment: InferenceNode[][],
  dispatchPerSegment: (string | null)[],
  positions: Map<string, Box>,
  model: InferenceFlowModel,
  offsetX: number,
  offsetY: number,
): { width: number; height: number } {
  if (segmentsCount === 0) return { width: 0, height: 0 };

  let cursorY = offsetY;
  let maxRight = offsetX + SEGMENT_WIDTH;

  for (let i = 0; i < segmentsCount; i++) {
    const segId = `${branchKey}::seg:${i}`;
    const inferences = inferencesPerSegment[i];
    const segH = segmentHeight(inferences);
    const segY = cursorY;
    positions.set(segId, {
      x: offsetX,
      y: segY,
      width: SEGMENT_WIDTH,
      height: segH,
    });

    let segBottom = segY + segH;
    const childBranchId = dispatchPerSegment[i];
    if (childBranchId) {
      const subAnchorX = offsetX + SEGMENT_WIDTH + HORIZONTAL_GAP;
      const subInferences = model.branches.get(childBranchId) ?? [];
      if (subInferences.length > 0) {
        const subSegments = segmentByDispatch(subInferences);
        const subInferencesPerSegment = subSegments.map((s) => s.leading);
        const subDispatchPerSegment = subSegments.map((s) => s.dispatchBranchId);
        const subBox = layoutSegmentChain(
          childBranchId,
          subSegments.length,
          subInferencesPerSegment,
          subDispatchPerSegment,
          positions,
          model,
          subAnchorX,
          segY,
        );
        segBottom = Math.max(segBottom, segY + subBox.height);
        maxRight = Math.max(maxRight, subAnchorX + subBox.width);
      }
    }

    cursorY = segBottom + RAIL_GAP;
  }

  return {
    width: maxRight - offsetX,
    height: cursorY - offsetY - RAIL_GAP,
  };
}

interface InternalSegment {
  leading: InferenceNode[];
  dispatchBranchId: string | null;
}

// Mirror buildGraph's segmentInferences but only producing the data layout
// needs (the child branch id of any dispatch).
function segmentByDispatch(inferences: InferenceNode[]): InternalSegment[] {
  const segments: InternalSegment[] = [];
  let buf: InferenceNode[] = [];
  for (const inf of inferences) {
    buf.push(inf);
    if (inf.dispatches.length === 0) continue;
    for (let i = 0; i < inf.dispatches.length; i++) {
      const d = inf.dispatches[i];
      segments.push({ leading: buf, dispatchBranchId: d.childBranchId });
      buf = [];
    }
  }
  if (buf.length > 0) {
    segments.push({ leading: buf, dispatchBranchId: null });
  }
  return segments;
}

interface MainTurnGroup {
  branchKey: string;
  inferences: InferenceNode[];
}

function groupMainInferencesByTurn(infs: InferenceNode[]): MainTurnGroup[] {
  const groups = new Map<string, MainTurnGroup>();
  for (const inf of infs) {
    const tn = inf.turnNumber;
    const key = tn !== null ? `turn:${tn}` : `turn:orphan:${inf.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { branchKey: key, inferences: [] };
      groups.set(key, g);
    }
    g.inferences.push(inf);
  }
  return Array.from(groups.values());
}

function layoutMainRail(
  model: InferenceFlowModel,
  positions: Map<string, Box>,
  startY: number,
): number {
  const main = model.branches.get('main') ?? [];
  if (main.length === 0) return startY;

  let cursorY = startY;
  for (const group of groupMainInferencesByTurn(main)) {
    const segs = segmentByDispatch(group.inferences);
    if (segs.length === 0) continue;
    const box = layoutSegmentChain(
      group.branchKey,
      segs.length,
      segs.map((s) => s.leading),
      segs.map((s) => s.dispatchBranchId),
      positions,
      model,
      TOP_LEVEL_MARGIN_X,
      cursorY,
    );
    cursorY += box.height + RAIL_GAP;
  }
  return cursorY - RAIL_GAP;
}

export function layoutGraph(
  nodes: InferenceFlowNode[],
  edges: InferenceFlowEdge[],
  model: InferenceFlowModel,
): { nodes: InferenceFlowNode[]; edges: InferenceFlowEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const positions = new Map<string, Box>();
  const mainEndY = layoutMainRail(model, positions, TOP_LEVEL_MARGIN_Y);

  let unattachedY = mainEndY + UNATTACHED_GAP;
  model.unattachedBranchIds.forEach((bid, i) => {
    const inferences = model.branches.get(bid) ?? [];
    if (inferences.length === 0) return;
    const segs = segmentByDispatch(inferences);
    const box = layoutSegmentChain(
      `unattached:${i}`,
      segs.length,
      segs.map((s) => s.leading),
      segs.map((s) => s.dispatchBranchId),
      positions,
      model,
      TOP_LEVEL_MARGIN_X,
      unattachedY,
    );
    unattachedY += box.height + UNATTACHED_GAP;
  });

  const positioned: InferenceFlowNode[] = nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return node;
    return {
      ...node,
      position: { x: pos.x, y: pos.y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    } as InferenceFlowNode;
  });

  return { nodes: positioned, edges };
}

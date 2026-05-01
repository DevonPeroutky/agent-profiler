import { Position } from '@xyflow/react';
import type {
  InferenceFlowEdge,
  InferenceFlowNode,
  SubagentBoundaryData,
  SubagentGroupData,
} from './types';
import type { InferenceFlowModel, InferenceNode } from '../transforms';

const NODE_WIDTH = 280;
const NODE_HEIGHT_BY_TYPE: Record<string, number> = {
  inference: 110,
  subagentHeader: 44,
  subagentReturn: 40,
};
const INFERENCE_TOOLS_ROW_HEIGHT = 26;
const INFERENCE_TOOLS_GAP = 6;
const INFERENCE_TOOLS_PER_ROW = 3;

const VERTICAL_GAP = 32;
const HORIZONTAL_GAP = 80;
const GROUP_PADDING_X = 16;
const GROUP_PADDING_TOP = 12;
const GROUP_PADDING_BOTTOM = 12;
const TOP_LEVEL_MARGIN_X = 32;
const TOP_LEVEL_MARGIN_Y = 32;
const UNATTACHED_GAP = 80;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function inferenceHeight(inf: InferenceNode): number {
  const base = NODE_HEIGHT_BY_TYPE.inference;
  const toolCount = inf.emittedTools.length;
  if (toolCount === 0) return base;
  const rows = Math.ceil(toolCount / INFERENCE_TOOLS_PER_ROW);
  return base + rows * INFERENCE_TOOLS_ROW_HEIGHT + INFERENCE_TOOLS_GAP;
}

function headerHeight(): number {
  return NODE_HEIGHT_BY_TYPE.subagentHeader;
}

function returnHeight(): number {
  return NODE_HEIGHT_BY_TYPE.subagentReturn;
}

function layoutBranch(
  inferences: InferenceNode[],
  model: InferenceFlowModel,
  positions: Map<string, Box>,
  offsetX: number,
  offsetY: number,
): { width: number; height: number } {
  if (inferences.length === 0) {
    return { width: 0, height: 0 };
  }

  let cursorY = offsetY;
  let maxRight = offsetX + NODE_WIDTH;

  for (const inf of inferences) {
    const infY = cursorY;
    const infH = inferenceHeight(inf);
    positions.set(inf.id, {
      x: offsetX,
      y: infY,
      width: NODE_WIDTH,
      height: infH,
    });

    let dispatchY = infY;
    let dispatchBottom = infY + infH;
    const dispatchOriginX = offsetX + NODE_WIDTH + HORIZONTAL_GAP;

    for (const dispatch of inf.dispatches) {
      const groupId = `${dispatch.childBranchId}::group`;
      const headerId = `${dispatch.childBranchId}::header`;
      const returnId = `${dispatch.childBranchId}::return`;
      const subInferences = model.branches.get(dispatch.childBranchId) ?? [];

      // Group children live in the group's local coordinate system.
      const headerLocalX = GROUP_PADDING_X;
      const headerLocalY = GROUP_PADDING_TOP;
      const headerH = headerHeight();
      positions.set(headerId, {
        x: headerLocalX,
        y: headerLocalY,
        width: NODE_WIDTH,
        height: headerH,
      });

      const innerOffsetX = GROUP_PADDING_X;
      const innerOffsetY = headerLocalY + headerH + VERTICAL_GAP;
      const innerBox = layoutBranch(
        subInferences,
        model,
        positions,
        innerOffsetX,
        innerOffsetY,
      );

      const innerEndY =
        subInferences.length === 0 ? innerOffsetY : innerOffsetY + innerBox.height;
      const returnLocalY = innerEndY + VERTICAL_GAP;
      const returnH = returnHeight();
      positions.set(returnId, {
        x: GROUP_PADDING_X,
        y: returnLocalY,
        width: NODE_WIDTH,
        height: returnH,
      });

      const innerWidth = Math.max(innerBox.width, NODE_WIDTH);
      const groupWidth = innerWidth + GROUP_PADDING_X * 2;
      const groupHeight = returnLocalY + returnH + GROUP_PADDING_BOTTOM;

      positions.set(groupId, {
        x: dispatchOriginX,
        y: dispatchY,
        width: groupWidth,
        height: groupHeight,
      });

      dispatchY += groupHeight + VERTICAL_GAP;
      dispatchBottom = dispatchY - VERTICAL_GAP;
      maxRight = Math.max(maxRight, dispatchOriginX + groupWidth);
    }

    cursorY = Math.max(infY + infH, dispatchBottom) + VERTICAL_GAP;
  }

  return {
    width: maxRight - offsetX,
    height: cursorY - offsetY - VERTICAL_GAP,
  };
}

export function layoutGraph(
  nodes: InferenceFlowNode[],
  edges: InferenceFlowEdge[],
  model: InferenceFlowModel,
): { nodes: InferenceFlowNode[]; edges: InferenceFlowEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const positions = new Map<string, Box>();
  const mainInferences = model.branches.get('main') ?? [];
  const mainBox = layoutBranch(
    mainInferences,
    model,
    positions,
    TOP_LEVEL_MARGIN_X,
    TOP_LEVEL_MARGIN_Y,
  );

  let unattachedY = TOP_LEVEL_MARGIN_Y + mainBox.height + UNATTACHED_GAP;
  for (const bid of model.unattachedBranchIds) {
    const inferences = model.branches.get(bid) ?? [];
    const box = layoutBranch(
      inferences,
      model,
      positions,
      TOP_LEVEL_MARGIN_X,
      unattachedY,
    );
    unattachedY += box.height + UNATTACHED_GAP;
  }

  const positioned: InferenceFlowNode[] = nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return node;
    if (node.type === 'subagentGroup') {
      const data = node.data as SubagentGroupData;
      return {
        ...node,
        position: { x: pos.x, y: pos.y },
        style: { width: pos.width, height: pos.height },
        data,
        zIndex: -1,
        selectable: false,
      } as InferenceFlowNode;
    }
    const baseUpdate = {
      ...node,
      position: { x: pos.x, y: pos.y },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
    if (node.type === 'subagentHeader' || node.type === 'subagentReturn') {
      return { ...baseUpdate, data: node.data as SubagentBoundaryData } as InferenceFlowNode;
    }
    return baseUpdate as InferenceFlowNode;
  });

  return { nodes: positioned, edges };
}

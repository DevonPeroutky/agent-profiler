import { Position } from '@xyflow/react';
import type { InferenceFlowEdge, InferenceFlowNode } from './types';
import type { InferenceFlowModel, InferenceNode } from '../transforms';
import {
  groupMainByTurn,
  segmentInferences,
  type MainTurnGroup,
  type Segment,
} from './turnGroups';
import type { Turn } from '@/types';

const SEGMENT_WIDTH = 320;
const HEADER_HEIGHT = 28;
const SEGMENT_PADDING_TOP = 8;
const SEGMENT_PADDING_BOTTOM = 8;

// Card chrome (model row, token bar, divider) — base height before tool
// chips. Tool chips render inside the card under a divider, so they add
// vertical space on top of the base.
const INFERENCE_BLOCK_HEIGHT = 78;
const INFERENCE_TOOLS_ROW_HEIGHT = 22;
const INFERENCE_TOOLS_GAP = 10;
const INFERENCE_TOOLS_PER_ROW = 3;
const INNER_GAP = 8;

// Card chrome (badge row + 1 line) plus space for up to 6 wrapped lines.
const USER_PROMPT_BASE_HEIGHT = 48;
const USER_PROMPT_LINE_HEIGHT = 16;
const USER_PROMPT_MAX_LINES = 6;
const USER_PROMPT_AVG_CHARS_PER_LINE = 44;
const PROMPT_TO_SEGMENT_GAP = 12;

function userPromptHeight(label: string | null): number {
  if (!label) return USER_PROMPT_BASE_HEIGHT + USER_PROMPT_LINE_HEIGHT;
  const lines = Math.min(
    USER_PROMPT_MAX_LINES,
    Math.max(1, Math.ceil(label.length / USER_PROMPT_AVG_CHARS_PER_LINE)),
  );
  return USER_PROMPT_BASE_HEIGHT + lines * USER_PROMPT_LINE_HEIGHT;
}

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
  segments: Segment[],
  positions: Map<string, Box>,
  model: InferenceFlowModel,
  offsetX: number,
  offsetY: number,
): { width: number; height: number } {
  if (segments.length === 0) return { width: 0, height: 0 };

  let cursorY = offsetY;
  let maxRight = offsetX + SEGMENT_WIDTH;

  for (let i = 0; i < segments.length; i++) {
    const segId = `${branchKey}::seg:${i}`;
    const seg = segments[i];
    const segH = segmentHeight(seg.leadingInferences);
    const segY = cursorY;
    positions.set(segId, {
      x: offsetX,
      y: segY,
      width: SEGMENT_WIDTH,
      height: segH,
    });

    let segBottom = segY + segH;
    const childBranchId = seg.dispatchAfter?.childBranchId ?? null;
    if (childBranchId) {
      const subAnchorX = offsetX + SEGMENT_WIDTH + HORIZONTAL_GAP;
      const subInferences = model.branches.get(childBranchId) ?? [];
      if (subInferences.length > 0) {
        const subBox = layoutSegmentChain(
          childBranchId,
          segmentInferences(subInferences),
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

// Lay out a single main-rail turn group: prompt node on top, then either a
// turnSegment chain (real inferences) or a stack of subagentSegment chains
// (slash-command synthetic dispatches) below. Returns the total vertical
// extent and width consumed.
function layoutTurnGroup(
  group: MainTurnGroup,
  positions: Map<string, Box>,
  model: InferenceFlowModel,
  offsetX: number,
  offsetY: number,
): { width: number; height: number } {
  const promptId = `${group.id}::prompt`;
  const promptHeight = userPromptHeight(group.promptLabel);
  positions.set(promptId, {
    x: offsetX,
    y: offsetY,
    width: SEGMENT_WIDTH,
    height: promptHeight,
  });

  const chainTopY = offsetY + promptHeight + PROMPT_TO_SEGMENT_GAP;
  let maxRight = offsetX + SEGMENT_WIDTH;
  let chainHeight = 0;

  if (group.realInferences.length > 0) {
    const box = layoutSegmentChain(
      group.id,
      segmentInferences(group.realInferences),
      positions,
      model,
      offsetX,
      chainTopY,
    );
    maxRight = Math.max(maxRight, offsetX + box.width);
    chainHeight = box.height;
  } else if (group.syntheticDispatches.length > 0) {
    let cursorY = chainTopY;
    for (const d of group.syntheticDispatches) {
      const subInferences = model.branches.get(d.childBranchId) ?? [];
      if (subInferences.length === 0) continue;
      const box = layoutSegmentChain(
        d.childBranchId,
        segmentInferences(subInferences),
        positions,
        model,
        offsetX,
        cursorY,
      );
      maxRight = Math.max(maxRight, offsetX + box.width);
      cursorY += box.height + RAIL_GAP;
    }
    chainHeight = Math.max(0, cursorY - chainTopY - RAIL_GAP);
  }

  const totalHeight =
    promptHeight +
    (chainHeight > 0 ? PROMPT_TO_SEGMENT_GAP + chainHeight : 0);
  return { width: maxRight - offsetX, height: totalHeight };
}

function layoutMainRail(
  model: InferenceFlowModel,
  conversation: { turns: readonly Turn[] },
  positions: Map<string, Box>,
  startY: number,
): number {
  const main = model.branches.get('main') ?? [];
  if (main.length === 0) return startY;

  const turnsByNumber = new Map<number, Turn>();
  for (const t of conversation.turns) turnsByNumber.set(t.turnNumber, t);
  const groups = groupMainByTurn(main, turnsByNumber);

  let cursorY = startY;
  for (const group of groups) {
    const box = layoutTurnGroup(
      group,
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
  conversation: { turns: readonly Turn[] },
): { nodes: InferenceFlowNode[]; edges: InferenceFlowEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const positions = new Map<string, Box>();
  const mainEndY = layoutMainRail(
    model,
    conversation,
    positions,
    TOP_LEVEL_MARGIN_Y,
  );

  let unattachedY = mainEndY + UNATTACHED_GAP;
  model.unattachedBranchIds.forEach((bid, i) => {
    const inferences = model.branches.get(bid) ?? [];
    if (inferences.length === 0) return;
    const box = layoutSegmentChain(
      `unattached:${i}`,
      segmentInferences(inferences),
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

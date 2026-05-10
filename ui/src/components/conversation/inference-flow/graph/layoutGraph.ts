import type { Turn } from '@/types';
import { Position } from '@xyflow/react';
import type { InferenceFlowModel, InferenceNode } from '../transforms';
import { type MainTurnGroup, type Segment, groupMainByTurn, segmentInferences } from './turnGroups';
import type { InferenceFlowEdge, InferenceFlowNode } from './types';

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

// Collapsed-bundle leaf: header + a single summary row.
const COLLAPSED_SUMMARY_HEIGHT = 24;
const COLLAPSED_SEGMENT_HEIGHT =
  HEADER_HEIGHT + SEGMENT_PADDING_TOP + COLLAPSED_SUMMARY_HEIGHT + SEGMENT_PADDING_BOTTOM;

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
// Horizontal gap between adjacent turn columns. Larger than the within-turn
// HORIZONTAL_GAP so the visual break between turns is obvious at a glance.
const INTER_TURN_GAP = 96;

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

function segmentHeight(inferences: InferenceNode[], isCollapsed: boolean): number {
  if (isCollapsed) return COLLAPSED_SEGMENT_HEIGHT;
  if (inferences.length === 0) {
    return HEADER_HEIGHT + SEGMENT_PADDING_TOP + SEGMENT_PADDING_BOTTOM;
  }
  const blocks = inferences.reduce((s, i) => s + inferenceBlockHeight(i), 0);
  const gaps = (inferences.length - 1) * INNER_GAP;
  return HEADER_HEIGHT + SEGMENT_PADDING_TOP + blocks + gaps + SEGMENT_PADDING_BOTTOM;
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
  collapsed: ReadonlySet<string>,
): { width: number; height: number } {
  if (segments.length === 0) return { width: 0, height: 0 };

  let cursorY = offsetY;
  let maxRight = offsetX + SEGMENT_WIDTH;

  for (let i = 0; i < segments.length; i++) {
    const segId = `${branchKey}::seg:${i}`;
    const seg = segments[i];
    const segH = segmentHeight(seg.leadingInferences, collapsed.has(segId));
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
          collapsed,
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
  collapsed: ReadonlySet<string>,
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
      collapsed,
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
        collapsed,
      );
      maxRight = Math.max(maxRight, offsetX + box.width);
      cursorY += box.height + RAIL_GAP;
    }
    chainHeight = Math.max(0, cursorY - chainTopY - RAIL_GAP);
  }

  const totalHeight = promptHeight + (chainHeight > 0 ? PROMPT_TO_SEGMENT_GAP + chainHeight : 0);
  return { width: maxRight - offsetX, height: totalHeight };
}

// Lay turns out left→right. Each turn keeps its existing internal TB layout
// (prompt on top, segments stacked below, subagent column branching to the
// right of its dispatcher). Returns the bottom-most Y across all turns so the
// caller can place unattached branches underneath.
function layoutMainRail(
  model: InferenceFlowModel,
  conversation: { turns: readonly Turn[] },
  positions: Map<string, Box>,
  startX: number,
  startY: number,
  collapsed: ReadonlySet<string>,
): number {
  const main = model.branches.get('main') ?? [];
  if (main.length === 0) return startY;

  const turnsByNumber = new Map<number, Turn>();
  for (const t of conversation.turns) turnsByNumber.set(t.turnNumber, t);
  const groups = groupMainByTurn(main, turnsByNumber);

  let cursorX = startX;
  let maxBottomY = startY;
  for (const group of groups) {
    const box = layoutTurnGroup(group, positions, model, cursorX, startY, collapsed);
    cursorX += box.width + INTER_TURN_GAP;
    maxBottomY = Math.max(maxBottomY, startY + box.height);
  }
  return maxBottomY;
}

export function layoutGraph(
  nodes: InferenceFlowNode[],
  edges: InferenceFlowEdge[],
  model: InferenceFlowModel,
  conversation: { turns: readonly Turn[] },
  collapsedSegmentIds: ReadonlySet<string>,
): { nodes: InferenceFlowNode[]; edges: InferenceFlowEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const positions = new Map<string, Box>();
  const mainEndY = layoutMainRail(
    model,
    conversation,
    positions,
    TOP_LEVEL_MARGIN_X,
    TOP_LEVEL_MARGIN_Y,
    collapsedSegmentIds,
  );

  let unattachedY = mainEndY + UNATTACHED_GAP;
  for (const bid of model.unattachedBranchIds) {
    const inferences = model.branches.get(bid) ?? [];
    if (inferences.length === 0) continue;
    const box = layoutSegmentChain(
      bid,
      segmentInferences(inferences),
      positions,
      model,
      TOP_LEVEL_MARGIN_X,
      unattachedY,
      collapsedSegmentIds,
    );
    unattachedY += box.height + UNATTACHED_GAP;
  }

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

import type {
  EdgeTone,
  FlowTone,
  InferenceFlowEdge,
  InferenceFlowNode,
} from './types';
import type { InferenceFlowModel } from '../transforms';

interface BranchExit {
  id: string;
  isReturn: boolean;
}

interface ProcessResult {
  entryId: string | null;
  exits: BranchExit[];
}

interface Acc {
  nodes: InferenceFlowNode[];
  edges: InferenceFlowEdge[];
  edgeIds: Set<string>;
}

function pushEdge(
  acc: Acc,
  source: string,
  target: string,
  tone: EdgeTone,
  sourceHandle: string,
  targetHandle: string,
): void {
  const id = `${source}->${target}`;
  if (acc.edgeIds.has(id)) return;
  acc.edgeIds.add(id);
  acc.edges.push({
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: 'smoothstep',
    data: { tone },
  });
}

function processBranch(
  model: InferenceFlowModel,
  branchId: string,
  tone: FlowTone,
  parentGroupId: string | undefined,
  depth: number,
  acc: Acc,
): ProcessResult {
  const inferences = model.branches.get(branchId) ?? [];
  if (inferences.length === 0) return { entryId: null, exits: [] };

  let entryId: string | null = null;
  let prevExits: BranchExit[] = [];

  const inboundEdgeTone: EdgeTone =
    tone === 'subagent' ? 'subagent' : 'default';

  for (const inf of inferences) {
    acc.nodes.push({
      id: inf.id,
      type: 'inference',
      data: { node: inf, tone },
      position: { x: 0, y: 0 },
      ...(parentGroupId
        ? { parentId: parentGroupId, extent: 'parent' as const }
        : {}),
    });

    if (entryId === null) entryId = inf.id;

    for (const exit of prevExits) {
      pushEdge(
        acc,
        exit.id,
        inf.id,
        exit.isReturn ? 'return' : inboundEdgeTone,
        exit.isReturn ? 'left' : 'bottom',
        'top',
      );
    }

    if (inf.dispatches.length === 0) {
      prevExits = [{ id: inf.id, isReturn: false }];
      continue;
    }

    const newExits: BranchExit[] = [];
    for (const dispatch of inf.dispatches) {
      const groupId = `${dispatch.childBranchId}::group`;
      const headerId = `${dispatch.childBranchId}::header`;
      const returnId = `${dispatch.childBranchId}::return`;

      acc.nodes.push({
        id: groupId,
        type: 'subagentGroup',
        data: { dispatch, depth: depth + 1 },
        position: { x: 0, y: 0 },
        ...(parentGroupId
          ? { parentId: parentGroupId, extent: 'parent' as const }
          : {}),
      });

      acc.nodes.push({
        id: headerId,
        type: 'subagentHeader',
        data: { dispatch, tone: 'subagent' },
        position: { x: 0, y: 0 },
        parentId: groupId,
        extent: 'parent',
      });
      acc.nodes.push({
        id: returnId,
        type: 'subagentReturn',
        data: { dispatch, tone: 'subagent' },
        position: { x: 0, y: 0 },
        parentId: groupId,
        extent: 'parent',
      });

      pushEdge(acc, inf.id, headerId, 'dispatch', 'right', 'left');

      const sub = processBranch(
        model,
        dispatch.childBranchId,
        'subagent',
        groupId,
        depth + 1,
        acc,
      );

      if (sub.entryId) {
        pushEdge(acc, headerId, sub.entryId, 'subagent', 'bottom', 'top');
        for (const exit of sub.exits) {
          pushEdge(
            acc,
            exit.id,
            returnId,
            exit.isReturn ? 'return' : 'subagent',
            exit.isReturn ? 'left' : 'bottom',
            'top',
          );
        }
      } else {
        pushEdge(acc, headerId, returnId, 'subagent', 'bottom', 'top');
      }

      newExits.push({ id: returnId, isReturn: true });
    }
    prevExits = newExits;
  }

  return { entryId, exits: prevExits };
}

export function buildGraph(model: InferenceFlowModel): {
  nodes: InferenceFlowNode[];
  edges: InferenceFlowEdge[];
} {
  const acc: Acc = { nodes: [], edges: [], edgeIds: new Set() };
  processBranch(model, 'main', 'default', undefined, 0, acc);
  for (const bid of model.unattachedBranchIds) {
    processBranch(model, bid, 'unattached', undefined, 0, acc);
  }
  return { nodes: acc.nodes, edges: acc.edges };
}

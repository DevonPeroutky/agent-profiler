import type { ConversationSummary, Turn } from '@/types';
import type {
  EdgeTone,
  FlowTone,
  InferenceFlowEdge,
  InferenceFlowNode,
  SegmentData,
  SubagentSegmentData,
  UserPromptData,
} from './types';
import type { Dispatch, InferenceFlowModel } from '../transforms';
import {
  groupMainByTurn,
  segmentInferences,
  type MainTurnGroup,
  type Segment,
} from './turnGroups';

interface RailExit {
  id: string;
  handle: 'bottom';
  tone: EdgeTone;
}

interface ChainResult {
  entryId: string;
  exits: RailExit[];
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

interface EmitChainArgs {
  segments: Segment[];
  branchKey: string;
  tone: FlowTone;
  nodeType: 'turnSegment' | 'subagentSegment';
  turnNumber: number | null;
  // For subagent chains: the dispatch that opened this bundle (attached to
  // the first segment so its header can render "Skill · Explore" etc.).
  firstSegmentDispatch?: Dispatch;
  incomingExits: RailExit[];
  model: InferenceFlowModel;
  acc: Acc;
}

// Emits a vertical chain of segments and recurses into any dispatched
// subagent subtree per segment. Returns the entry node id and trailing
// exits for the caller to wire onward. Null when there's nothing to emit.
function emitSegmentChain(args: EmitChainArgs): ChainResult | null {
  const {
    segments,
    branchKey,
    tone,
    nodeType,
    turnNumber,
    firstSegmentDispatch,
    incomingExits,
    model,
    acc,
  } = args;
  if (segments.length === 0) return null;

  let entryId: string | null = null;
  let prevExits: RailExit[] = incomingExits;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nodeId = `${branchKey}::seg:${i}`;
    const isFirstSegment = i === 0;
    const baseData: SegmentData = {
      turnNumber,
      segmentIndex: i,
      isFirstSegment,
      inferences: seg.leadingInferences,
      endsInDispatch: seg.dispatchAfter !== null,
      tone,
    };

    if (nodeType === 'subagentSegment') {
      const data: SubagentSegmentData = {
        ...baseData,
        ...(isFirstSegment && firstSegmentDispatch
          ? { dispatch: firstSegmentDispatch }
          : {}),
      };
      acc.nodes.push({
        id: nodeId,
        type: 'subagentSegment',
        data,
        position: { x: 0, y: 0 },
      });
    } else {
      acc.nodes.push({
        id: nodeId,
        type: 'turnSegment',
        data: baseData,
        position: { x: 0, y: 0 },
      });
    }

    if (entryId === null) entryId = nodeId;

    for (const exit of prevExits) {
      pushEdge(acc, exit.id, nodeId, exit.tone, exit.handle, 'top');
    }

    if (seg.dispatchAfter) {
      const sub = processSubagentBranch(
        seg.dispatchAfter.childBranchId,
        seg.dispatchAfter,
        model,
        acc,
      );
      if (sub) {
        pushEdge(acc, nodeId, sub.entryId, 'dispatch', 'right', 'top');
        // Subagent's trailing exits flow back to the next segment as
        // `return`-toned edges (control returning to the parent inference).
        prevExits = sub.exits.map((e) => ({ ...e, tone: 'return' as const }));
      } else {
        prevExits = [{ id: nodeId, handle: 'bottom', tone: 'default' }];
      }
    } else {
      prevExits = [
        {
          id: nodeId,
          handle: 'bottom',
          tone: tone === 'subagent' ? 'subagent' : 'default',
        },
      ];
    }
  }

  return { entryId: entryId!, exits: prevExits };
}

function processSubagentBranch(
  branchId: string,
  dispatch: Dispatch,
  model: InferenceFlowModel,
  acc: Acc,
): ChainResult | null {
  const inferences = model.branches.get(branchId) ?? [];
  if (inferences.length === 0) return null;
  return emitSegmentChain({
    segments: segmentInferences(inferences),
    branchKey: branchId,
    tone: 'subagent',
    nodeType: 'subagentSegment',
    turnNumber: null,
    firstSegmentDispatch: dispatch,
    incomingExits: [],
    model,
    acc,
  });
}

// Emits a slash-dispatched subagent chain underneath a prompt node. Wires
// `incomingExits` into the chain's entry; returns either the chain's
// trailing exits (re-toned to `subagent` so sibling chains see a violet
// connector) or `incomingExits` unchanged if the subagent branch is empty
// — the rail keeps moving so the next dispatch / next turn doesn't dangle.
function emitSubagentChainUnderPrompt(
  dispatch: Dispatch,
  model: InferenceFlowModel,
  acc: Acc,
  incomingExits: RailExit[],
): RailExit[] {
  const inferences = model.branches.get(dispatch.childBranchId) ?? [];
  if (inferences.length === 0) return incomingExits;
  const result = emitSegmentChain({
    segments: segmentInferences(inferences),
    branchKey: dispatch.childBranchId,
    tone: 'subagent',
    nodeType: 'subagentSegment',
    turnNumber: null,
    firstSegmentDispatch: dispatch,
    incomingExits,
    model,
    acc,
  });
  if (!result) return incomingExits;
  return result.exits.map((e) => ({ ...e, tone: 'subagent' as const }));
}

function emitTurnGroup(
  group: MainTurnGroup,
  model: InferenceFlowModel,
  acc: Acc,
  prevExits: RailExit[],
): RailExit[] {
  const promptId = `${group.id}::prompt`;
  const promptData: UserPromptData = {
    turnNumber: group.turnNumber,
    promptLabel: group.promptLabel,
    isSlashCommand: group.isSlashCommand,
    span: group.span,
  };
  acc.nodes.push({
    id: promptId,
    type: 'userPromptNode',
    data: promptData,
    position: { x: 0, y: 0 },
  });
  for (const exit of prevExits) {
    pushEdge(acc, exit.id, promptId, exit.tone, exit.handle, 'top');
  }

  const promptExit: RailExit = {
    id: promptId,
    handle: 'bottom',
    tone: 'default',
  };

  // A turn either has real inferences (normal turn) or only synthetic
  // dispatches (slash-command turn). The transformer never produces both
  // in the same turn — `walkTurn` only creates a synthetic node when no
  // inference-parented dispatches exist (transforms.ts:332).
  if (group.realInferences.length > 0) {
    const result = emitSegmentChain({
      segments: segmentInferences(group.realInferences),
      branchKey: group.id,
      tone: 'default',
      nodeType: 'turnSegment',
      turnNumber: group.turnNumber,
      incomingExits: [promptExit],
      model,
      acc,
    });
    return result?.exits ?? [promptExit];
  }

  if (group.syntheticDispatches.length > 0) {
    let chainExits: RailExit[] = [promptExit];
    for (const d of group.syntheticDispatches) {
      chainExits = emitSubagentChainUnderPrompt(d, model, acc, chainExits);
    }
    return chainExits;
  }

  return [promptExit];
}

function processMainRail(
  model: InferenceFlowModel,
  conversation: ConversationSummary,
  acc: Acc,
): void {
  const main = model.branches.get('main') ?? [];
  if (main.length === 0) return;

  const turnsByNumber = new Map<number, Turn>();
  for (const t of conversation.turns) turnsByNumber.set(t.turnNumber, t);
  const groups = groupMainByTurn(main, turnsByNumber);

  let prevExits: RailExit[] = [];
  for (const group of groups) {
    prevExits = emitTurnGroup(group, model, acc, prevExits);
  }
}

function processUnattachedBranch(
  branchId: string,
  index: number,
  model: InferenceFlowModel,
  acc: Acc,
): void {
  const inferences = model.branches.get(branchId) ?? [];
  if (inferences.length === 0) return;
  emitSegmentChain({
    segments: segmentInferences(inferences),
    branchKey: `unattached:${index}`,
    tone: 'unattached',
    nodeType: 'subagentSegment',
    turnNumber: null,
    incomingExits: [],
    model,
    acc,
  });
}

export function buildGraph(
  model: InferenceFlowModel,
  conversation: ConversationSummary,
): {
  nodes: InferenceFlowNode[];
  edges: InferenceFlowEdge[];
} {
  const acc: Acc = { nodes: [], edges: [], edgeIds: new Set() };
  processMainRail(model, conversation, acc);
  model.unattachedBranchIds.forEach((bid, i) =>
    processUnattachedBranch(bid, i, model, acc),
  );
  return { nodes: acc.nodes, edges: acc.edges };
}

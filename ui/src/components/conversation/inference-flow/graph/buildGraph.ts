import type { ConversationSummary, Turn } from '@/types';
import type {
  EdgeTone,
  FlowTone,
  InferenceFlowEdge,
  InferenceFlowNode,
  SegmentData,
  SubagentSegmentData,
} from './types';
import type {
  Dispatch,
  InferenceFlowModel,
  InferenceNode,
} from '../transforms';

interface RailExit {
  id: string;
  handle: 'bottom';
  tone: EdgeTone;
}

interface BranchResult {
  entryId: string;
  exits: RailExit[];
}

interface Acc {
  nodes: InferenceFlowNode[];
  edges: InferenceFlowEdge[];
  edgeIds: Set<string>;
}

interface MainTurnGroup {
  id: string;
  turnNumber: number | null;
  promptLabel: string | null;
  inferences: InferenceNode[];
}

interface Segment {
  leadingInferences: InferenceNode[];
  dispatchAfter: Dispatch | null;
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

function truncatePromptLabel(raw: string | undefined, max = 80): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('/')) return cleaned.split(' ')[0];
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

function groupMainByTurn(
  inferences: InferenceNode[],
  turnsByNumber: Map<number, Turn>,
): MainTurnGroup[] {
  const groups = new Map<string, MainTurnGroup>();
  for (const inf of inferences) {
    const tn = inf.turnNumber;
    const key = tn !== null ? `turn:${tn}` : `turn:orphan:${inf.id}`;
    let g = groups.get(key);
    if (!g) {
      const turn = tn !== null ? turnsByNumber.get(tn) : undefined;
      const label =
        truncatePromptLabel(turn?.userPrompt) ?? inf.syntheticLabel ?? null;
      g = { id: key, turnNumber: tn, promptLabel: label, inferences: [] };
      groups.set(key, g);
    }
    g.inferences.push(inf);
  }
  return Array.from(groups.values());
}

// Split inferences into segments at every dispatch boundary. A segment ends
// either at a dispatch (then dispatchAfter is set) or at the end of the
// inference list (dispatchAfter null).
function segmentInferences(inferences: InferenceNode[]): Segment[] {
  const segments: Segment[] = [];
  let buf: InferenceNode[] = [];
  for (const inf of inferences) {
    buf.push(inf);
    if (inf.dispatches.length === 0) continue;
    for (let i = 0; i < inf.dispatches.length; i++) {
      const d = inf.dispatches[i];
      // First dispatch of an inference closes the current buffer (which
      // includes inf). Subsequent dispatches of the same inference produce
      // additional empty-buffer segments — rare, but kept structurally
      // consistent.
      segments.push({ leadingInferences: buf, dispatchAfter: d });
      buf = [];
    }
  }
  if (buf.length > 0) {
    segments.push({ leadingInferences: buf, dispatchAfter: null });
  }
  return segments;
}

function processSubagentBranch(
  branchId: string,
  dispatch: Dispatch,
  model: InferenceFlowModel,
  acc: Acc,
): BranchResult | null {
  const inferences = model.branches.get(branchId) ?? [];
  if (inferences.length === 0) return null;

  const segments = segmentInferences(inferences);
  return emitSegmentChain({
    segments,
    branchKey: branchId,
    tone: 'subagent',
    nodeType: 'subagentSegment',
    turnNumber: null,
    promptLabel: null,
    firstSegmentDispatch: dispatch,
    model,
    acc,
  });
}

interface EmitChainArgs {
  segments: Segment[];
  branchKey: string;
  tone: FlowTone;
  nodeType: 'turnSegment' | 'subagentSegment';
  turnNumber: number | null;
  promptLabel: string | null;
  // For subagent chains: the dispatch that opened this bundle (attached to the
  // first segment so its header can render "Skill · Explore" etc.).
  firstSegmentDispatch?: Dispatch;
  model: InferenceFlowModel;
  acc: Acc;
}

// Emits a vertical chain of segments and recurses into any dispatched
// subagent subtree per segment. Returns the entry node (first segment) and
// the trailing exits to wire onto whatever follows.
function emitSegmentChain(args: EmitChainArgs): BranchResult | null {
  const {
    segments,
    branchKey,
    tone,
    nodeType,
    turnNumber,
    promptLabel,
    firstSegmentDispatch,
    model,
    acc,
  } = args;
  if (segments.length === 0) return null;

  let entryId: string | null = null;
  let prevExits: RailExit[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nodeId = `${branchKey}::seg:${i}`;
    const isFirstOfTurn = i === 0;
    const baseData: SegmentData = {
      turnNumber,
      segmentIndex: i,
      isFirstOfTurn,
      promptLabel: isFirstOfTurn ? promptLabel : null,
      inferences: seg.leadingInferences,
      endsInDispatch: seg.dispatchAfter !== null,
      tone,
    };

    if (nodeType === 'subagentSegment') {
      const data: SubagentSegmentData = {
        ...baseData,
        ...(isFirstOfTurn && firstSegmentDispatch
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

    // Wire incoming edges from prevExits (rail or return) into this segment.
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
        // The next segment receives a `return`-toned edge from the subagent's
        // last segment(s), restoring the visual return-flow signal.
        prevExits = sub.exits.map((e) => ({ ...e, tone: 'return' as const }));
      } else {
        // Empty subagent branch: keep the chain moving via this segment's
        // bottom handle so the rail doesn't dead-end.
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
    const segments = segmentInferences(group.inferences);
    if (segments.length === 0) continue;

    // Inline chain emission (mirrors emitSegmentChain) so rail edges from a
    // previous turn's exits land on the new turn's entry seamlessly.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const nodeId = `${group.id}::seg:${i}`;
      const isFirstOfTurn = i === 0;
      const data: SegmentData = {
        turnNumber: group.turnNumber,
        segmentIndex: i,
        isFirstOfTurn,
        promptLabel: isFirstOfTurn ? group.promptLabel : null,
        inferences: seg.leadingInferences,
        endsInDispatch: seg.dispatchAfter !== null,
        tone: 'default',
      };
      acc.nodes.push({
        id: nodeId,
        type: 'turnSegment',
        data,
        position: { x: 0, y: 0 },
      });

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
          prevExits = sub.exits.map((e) => ({ ...e, tone: 'return' as const }));
        } else {
          prevExits = [{ id: nodeId, handle: 'bottom', tone: 'default' }];
        }
      } else {
        prevExits = [{ id: nodeId, handle: 'bottom', tone: 'default' }];
      }
    }
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
  const segments = segmentInferences(inferences);
  emitSegmentChain({
    segments,
    branchKey: `unattached:${index}`,
    tone: 'unattached',
    nodeType: 'subagentSegment',
    turnNumber: null,
    promptLabel: null,
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

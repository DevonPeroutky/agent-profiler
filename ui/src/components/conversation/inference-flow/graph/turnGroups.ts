import type { SpanNode, Turn } from '@/types';
import type { Dispatch, InferenceNode } from '../transforms';

export interface MainTurnGroup {
  id: string;
  turnNumber: number | null;
  promptLabel: string | null;
  isSlashCommand: boolean;
  span: SpanNode;
  realInferences: InferenceNode[];
  syntheticDispatches: Dispatch[];
}

export interface Segment {
  leadingInferences: InferenceNode[];
  dispatchAfter: Dispatch | null;
}

function truncatePromptLabel(raw: string | undefined, max = 280): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('/')) return cleaned.split(' ')[0];
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function groupMainByTurn(
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
      g = {
        id: key,
        turnNumber: tn,
        promptLabel: truncatePromptLabel(turn?.userPrompt) ?? inf.syntheticLabel ?? null,
        isSlashCommand: false,
        span: turn?.root ?? inf.span,
        realInferences: [],
        syntheticDispatches: [],
      };
      groups.set(key, g);
    }
    if (inf.isSynthetic) {
      g.span = inf.span;
      g.isSlashCommand = true;
      for (const d of inf.dispatches) g.syntheticDispatches.push(d);
      if (!g.promptLabel && inf.syntheticLabel) {
        g.promptLabel = inf.syntheticLabel;
      }
    } else {
      g.realInferences.push(inf);
    }
  }
  return Array.from(groups.values());
}

// Split inferences into segments at every dispatch boundary. A segment ends
// either at a dispatch (then dispatchAfter is set) or at the end of the
// inference list (dispatchAfter null).
export function segmentInferences(inferences: InferenceNode[]): Segment[] {
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

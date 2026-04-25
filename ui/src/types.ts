export interface SpanNode {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status?: { code?: number; message?: string };
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    timeMs?: number;
    attributes?: Record<string, unknown>;
  }>;
  children: SpanNode[];
}

export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * One user-prompt → agent-actions → agent-response exchange.
 *
 * INVARIANT: top-level scalar fields are a pure projection of values already
 * on `root.attributes` / `root.events`. `root.*` is authoritative; top-level
 * is a convenience mirror computed by the transformer. SpanDetail reads from
 * `root` directly; list-level UI reads from the mirrors.
 */
export interface Turn {
  kind: 'turn';
  traceId: string;
  sessionId: string;
  turnNumber: number;
  userPrompt: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  toolCount: number;
  errorCount: number;
  isMeta: boolean;
  isRunning: boolean;
  model: string | null;
  finalMode: string | null;
  cwd: string | null;
  contextTokens: TurnTokens;
  attachmentCount: number;
  attachmentBytes: number;
  root: SpanNode;
}

/**
 * Skill-dispatched subagent subtree with no paired tool_use in the main
 * transcript. No prompt, no response — not a conversational turn.
 */
export interface UnattachedGroup {
  kind: 'unattached';
  traceId: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  toolCount: number;
  errorCount: number;
  isRunning: boolean;
  cwd: string | null;
  root: SpanNode;
}

export type TraceSummary = Turn | UnattachedGroup;

export interface TracesResponse {
  traces: TraceSummary[];
}

export interface ConversationSummary {
  sessionId: string;
  turns: Turn[];
  unattached: UnattachedGroup[];
  startMs: number;
  endMs: number;
  durationMs: number;
  turnCount: number;
  toolCount: number;
  errorCount: number;
  isRunning: boolean;
  cwd: string | null;
}

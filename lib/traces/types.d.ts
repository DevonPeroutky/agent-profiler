// Shared wire-format types — the contract between the pure transformers in
// lib/<harness>/traces.js and everything downstream (adapter registry, store,
// API handler, React UI). Single source of truth: every side imports from
// here so the JSDoc-checked Node code and the .tsx-checked browser code
// cannot drift.
//
// Layering: harness-neutral. Nothing in this file may name or reference a
// specific harness (claude-code, codex, …). Harness-specific bundle shapes
// stay in lib/<harness>/transcripts.js.
//
// Why a .d.ts and not a .ts: lib/ runs as plain Node JS (no build step on
// the runtime path). A .d.ts produces no JS, so importing it from a JS file
// via `@typedef {import('./types.js').X}` is type-only and erased — same
// behavior as the TS-side `import type`.

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
  /**
   * Server-computed fingerprint over the served slice. Stable across no-op
   * polls; changes when any session is added, removed, or modified. Clients
   * may short-circuit re-render work when this matches the previous value.
   */
  version: string;
}

// Wire-format types (SpanNode, Turn, UnattachedGroup, TraceSummary, …) come
// from the shared declaration in lib/traces/types.d.ts so the JSDoc-checked
// transformers and this React app cannot drift. Re-exported here so existing
// `import … from '@/types'` call sites keep working unchanged.
//
// UI-only shapes (ConversationSummary, computed by groupConversations) live
// in this file — they're not part of the API contract.

export type {
  SpanNode,
  TraceSummary,
  TracesResponse,
  Turn,
  TurnTokens,
  UnattachedGroup,
} from '../../lib/traces/types';
import type { Turn, UnattachedGroup } from '../../lib/traces/types';

export interface ConversationSummary {
  /**
   * Adapter id of the harness that produced this conversation
   * (e.g. `'claude-code'`, `'codex'`). Derived in `groupConversations`
   * from `trace.root.attributes['agent_trace.harness']`; the registry
   * guarantees the attribute is present on every trace root.
   */
  harness: string;
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

/**
 * Record-level trace filters. Applied by the pure transformer in
 * `traces.js` before turn slicing, subagent pairing, and span emission.
 *
 * This is the server-side counterpart to `ui/src/lib/trace-filters.ts`,
 * which filters already-rendered SpanNode trees. The two layers stay
 * separate because the UI bundle cannot import `lib/traces/*` (it uses
 * `node:fs`). Same concept, different data shapes:
 *
 *   record-level (this file): TranscriptRecord → boolean
 *   span-level   (ui file)  : SpanNode         → boolean
 *
 * Add new record-level filters here so the transformer has a single
 * place to consult when deciding whether a JSONL row is real signal.
 *
 * @typedef {import('./transcripts.js').TranscriptRecord} TranscriptRecord
 */

/**
 * True when a record is a harness-injected `<task-notification>` row — the
 * synthetic message written when a background Bash task finishes. The
 * harness emits three row shapes; each clause ANDs a shape check with a
 * purpose check so legitimate queued user prompts (same shapes, different
 * commandMode / origin) are not filtered.
 *
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
export function isTaskNotification(rec) {
  if (
    rec?.type === 'queue-operation' &&
    typeof rec.content === 'string' &&
    rec.content.startsWith('<task-notification>')
  ) {
    return true;
  }
  if (rec?.origin?.kind === 'task-notification') return true;
  if (
    rec?.attachment?.type === 'queued_command' &&
    rec?.attachment?.commandMode === 'task-notification'
  ) {
    return true;
  }
  return false;
}

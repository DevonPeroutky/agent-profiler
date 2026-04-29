import { extractSlashCommand, stripLocalCommandCaveat } from '@/lib/utils';
import type { ConversationSummary } from '@/types';

// Matches a prompt whose entire content is a slash-command invocation —
// either a bare `/clear` / `/loop 5m foo` string (the transformer's normal
// shape) or the `<command-name>…</command-name>` envelope form
// (`extractSlashCommand`). Plain prose that happens to mention `/foo` mid-
// sentence won't match because the slash must be at the very start.
const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w:-]*(\s.*)?$/s;

function isPureSlashCommand(text: string): boolean {
  return SLASH_COMMAND_RE.test(text) || extractSlashCommand(text) !== null;
}

// Sidebar title text. Walks turns in order and returns the first user prompt
// that is not a pure slash command (`/clear`, `/compact`, …) — those are
// session controls, not a meaningful conversation label. Returns null if no
// turn qualifies; callers should fall back to a session-id short.
export function selectConversationPreview(
  conversation: ConversationSummary,
): string | null {
  for (const turn of conversation.turns) {
    if (turn.isMeta) continue;
    const stripped = stripLocalCommandCaveat(turn.userPrompt).trim();
    if (!stripped) continue;
    if (isPureSlashCommand(stripped)) continue;
    return stripped;
  }
  return null;
}

// First textual assistant reply across non-meta turns. Intentionally ignores
// `gen_ai.assistant.reasoning` (thinking blocks aren't a reply). Inference
// spans live as direct children of the turn root (one per requestId) and
// carry their content as events; we walk those but stop at `subagent:<type>`
// boundaries so subagent chatter doesn't get mislabeled as the
// conversation's first reply.
export function getFirstAssistantPreview(
  conversation: ConversationSummary,
): string | null {
  for (const turn of conversation.turns) {
    if (turn.isMeta) continue;
    const candidates = [
      ...(turn.root.events ?? []),
      ...turn.root.children
        .filter((c) => c.name === 'inference')
        .flatMap((c) => c.events ?? []),
    ];
    const msg = candidates.find((e) => e.name === 'gen_ai.assistant.message');
    if (!msg) continue;
    const text = String(msg.attributes?.['gen_ai.message.content'] ?? '').trim();
    if (text) return firstSentenceOf(text);
  }
  return null;
}

export function firstSentenceOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const m = oneLine.match(/[.!?](?=\s|$)/);
  if (m && m.index !== undefined && m.index < 180) {
    return oneLine.slice(0, m.index + 1);
  }
  return oneLine.length <= 180 ? oneLine : oneLine.slice(0, 180) + '…';
}

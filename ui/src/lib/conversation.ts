import { extractSlashCommand, stripLocalCommandCaveat } from '@/lib/utils';
import type { ConversationSummary } from '@/types';

export function getFirstPrompt(
  conversation: ConversationSummary,
): string | null {
  for (const turn of conversation.turns) {
    if (turn.isMeta) continue;
    const stripped = stripLocalCommandCaveat(turn.userPrompt);
    const cleaned = extractSlashCommand(stripped) ?? stripped;
    if (cleaned) return cleaned;
  }
  return null;
}

// First textual assistant reply across non-meta turns. Intentionally ignores
// `gen_ai.assistant.reasoning` (thinking blocks aren't a reply) and does not
// descend into child spans — if the only assistant text lives inside a
// `subagent:<type>` subtree, return null rather than mislabel subagent chatter
// as the conversation's first reply.
export function getFirstAssistantPreview(
  conversation: ConversationSummary,
): string | null {
  for (const turn of conversation.turns) {
    if (turn.isMeta) continue;
    const events = turn.root.events ?? [];
    const msg = events.find((e) => e.name === 'gen_ai.assistant.message');
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

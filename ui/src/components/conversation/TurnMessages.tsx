import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { TraceWaterfall } from '@/components/TraceWaterfall';
import type { ConversationSummary, SpanNode } from '@/types';
import { ChatMessage } from './ChatMessage';
import { TurnTimeline } from './TurnTimeline';
import {
  collectTurns,
  collectUnattached,
  hasVisibleActivity,
} from './transforms';

interface Props {
  conversation: ConversationSummary;
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
  showMeta: boolean;
}

const RAIL_TOP_INSET = 24; // matches Tailwind `top-6` = 1.5rem

export function TurnMessages({
  conversation,
  selectedSpanId,
  onSelectSpan,
  showMeta,
}: Props) {
  const allTurns = useMemo(() => collectTurns(conversation), [conversation]);
  const turns = useMemo(() => {
    const base = showMeta ? allTurns : allTurns.filter((t) => !t.isMeta);
    return base.filter(hasVisibleActivity);
  }, [allTurns, showMeta]);
  const unattached = useMemo(
    () => collectUnattached(conversation),
    [conversation],
  );
  const newestKey =
    unattached.length > 0
      ? unattached[unattached.length - 1].key
      : turns.length > 0
        ? turns[turns.length - 1].key
        : null;

  const [expanded, setExpanded] = useState<Set<string>>(() =>
    newestKey ? new Set([newestKey]) : new Set(),
  );

  useEffect(() => {
    setExpanded(newestKey ? new Set([newestKey]) : new Set());
  }, [conversation.sessionId, newestKey]);

  const railContainerRef = useRef<HTMLDivElement | null>(null);
  const lastAvatarRef = useRef<HTMLSpanElement | null>(null);
  const [railHeight, setRailHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const container = railContainerRef.current;
      const avatar = lastAvatarRef.current;
      if (!container || !avatar) {
        setRailHeight(null);
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      const avatarRect = avatar.getBoundingClientRect();
      const avatarCenter = avatarRect.top + avatarRect.height / 2;
      setRailHeight(Math.max(0, avatarCenter - containerTop - RAIL_TOP_INSET));
    };
    update();
    if (!railContainerRef.current) return;
    const ro = new ResizeObserver(update);
    ro.observe(railContainerRef.current);
    return () => ro.disconnect();
  }, [turns.length, unattached.length, expanded]);

  if (turns.length === 0 && unattached.length === 0) {
    return (
      <div className="px-6 py-8 text-xs text-muted-foreground">
        No turns captured for this conversation yet.
      </div>
    );
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const lastTurnIndex = turns.length - 1;
  const lastUnattachedIndex = unattached.length - 1;
  const lastEntryIsUnattached = unattached.length > 0;

  const totalEntries = turns.length + unattached.length;
  const turnCount = turns.length;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Messages
        </h2>
        <span className="text-xs text-muted-foreground/70">
          {totalEntries} message{totalEntries === 1 ? '' : 's'} · {turnCount} turn
          {turnCount === 1 ? '' : 's'}
        </span>
      </div>
      <div ref={railContainerRef} className="relative">
        {railHeight !== null && (
        <div
          aria-hidden
          style={{ height: railHeight }}
          className="pointer-events-none absolute left-[calc(1.5rem+12px-0.5px)] top-6 z-10 w-px bg-border"
        />
      )}
      {turns.map((entry, i) => {
        const isLastEntry = !lastEntryIsUnattached && i === lastTurnIndex;
        return (
          <ChatMessage
            key={entry.key}
            body={entry.prompt ?? ''}
            isOpen={expanded.has(entry.key)}
            onToggle={() => toggle(entry.key)}
            startMs={entry.turnSpan.startMs}
            isRunning={Boolean(
              entry.turnSpan.attributes?.['agent_trace.in_progress'],
            )}
            toolCount={entry.toolCount}
            models={entry.models}
            contextTokens={entry.contextTokens}
            attachmentCount={entry.attachmentCount}
            attachmentBytes={entry.attachmentBytes}
            finalMode={entry.finalMode}
            outcome={entry.outcome}
            assistantAvatarRef={isLastEntry ? lastAvatarRef : undefined}
            extraBadges={
              entry.isMeta ? (
                <Badge variant="outline" className="text-[10px]">
                  meta
                </Badge>
              ) : null
            }
          >
            <TurnTimeline
              turn={entry.turnSpan}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
              showReasoning={showMeta}
            />
          </ChatMessage>
        );
      })}
      {unattached.map((entry, i) => {
        const isLastEntry = i === lastUnattachedIndex;
        return (
          <ChatMessage
            key={entry.key}
            body={`${entry.subagentCount} subagent${entry.subagentCount === 1 ? '' : 's'} dispatched without parent turn`}
            bodyMuted
            omitUserRow
            isOpen={expanded.has(entry.key)}
            onToggle={() => toggle(entry.key)}
            startMs={entry.groupSpan.startMs}
            toolCount={entry.toolCount}
            models={entry.models}
            attachmentCount={0}
            attachmentBytes={0}
            assistantAvatarRef={isLastEntry ? lastAvatarRef : undefined}
            extraBadges={
              <Badge variant="outline" className="text-[10px]">
                {entry.subagentCount} subagent
                {entry.subagentCount === 1 ? '' : 's'}
              </Badge>
            }
          >
            <TraceWaterfall
              roots={entry.groupSpan.children}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
            />
          </ChatMessage>
        );
      })}
      </div>
    </section>
  );
}

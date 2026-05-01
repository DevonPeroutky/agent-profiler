import { useEffect, useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConversationList } from '@/components/ConversationList';
import { ConversationDetail } from '@/components/ConversationDetail';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTraces } from '@/hooks/useTraces';
import { useSidebarCollapsed } from '@/lib/sidebar';
import { cn } from '@/lib/utils';
import type {
  ConversationSummary,
  SpanNode,
  TraceSummary,
  Turn,
  UnattachedGroup,
} from '@/types';

function groupConversations(
  traces: TraceSummary[],
): ConversationSummary[] {
  const bySession = new Map<string, TraceSummary[]>();
  for (const t of traces) {
    const list = bySession.get(t.sessionId);
    if (list) list.push(t);
    else bySession.set(t.sessionId, [t]);
  }

  const conversations: ConversationSummary[] = [];
  for (const [sessionId, convTraces] of bySession.entries()) {
    const turns: Turn[] = [];
    const unattached: UnattachedGroup[] = [];
    for (const t of convTraces) {
      if (t.kind === 'turn') turns.push(t);
      else unattached.push(t);
    }
    turns.sort((a, b) => a.turnNumber - b.turnNumber);
    unattached.sort((a, b) => a.startMs - b.startMs);

    let startMs = Infinity;
    let endMs = -Infinity;
    let toolCount = 0;
    let errorCount = 0;
    for (const t of convTraces) {
      if (t.startMs < startMs) startMs = t.startMs;
      if (t.endMs > endMs) endMs = t.endMs;
      toolCount += t.toolCount;
      errorCount += t.errorCount;
    }

    conversations.push({
      sessionId,
      turns,
      unattached,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      turnCount: turns.length,
      toolCount,
      errorCount,
      isRunning:
        turns.some((t) => t.isRunning) ||
        unattached.some((u) => u.isRunning),
      cwd: convTraces.find((t) => t.cwd)?.cwd ?? null,
    });
  }

  conversations.sort((a, b) => b.endMs - a.endMs);
  return conversations;
}

export function App() {
  const { traces, loading, error } = useTraces();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectedSpan, setSelectedSpan] = useState<SpanNode | null>(null);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } =
    useSidebarCollapsed();

  const conversations = useMemo(() => groupConversations(traces), [traces]);

  useEffect(() => {
    setSelectedSessionId((prev) => {
      if (prev && conversations.some((c) => c.sessionId === prev)) return prev;
      return conversations[0]?.sessionId ?? null;
    });
  }, [conversations]);

  const selected = useMemo(
    () => conversations.find((c) => c.sessionId === selectedSessionId) ?? null,
    [conversations, selectedSessionId],
  );

  useEffect(() => {
    setSelectedSpan(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (selected) console.debug('[agent-trace]', selected);
  }, [selected]);

  return (
    <div className="flex h-screen">
      <aside
        className={cn(
          'flex w-80 shrink-0 flex-col border-r border-border',
          sidebarCollapsed && 'hidden',
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="h-8 w-8"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
          <h1 className="truncate text-sm font-semibold">agent-profiler</h1>
          <ThemeToggle />
        </div>
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            conversations={conversations}
            selectedSessionId={selectedSessionId}
            onSelect={setSelectedSessionId}
          />
        </div>
      </aside>

      <main className="relative flex flex-1 flex-col overflow-hidden">
        {sidebarCollapsed && (
          <Button
            size="icon"
            variant="outline"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="absolute left-2 top-2 z-10 h-8 w-8 bg-background shadow-sm"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        )}
        {error && (
          <div className="border-b border-destructive/50 bg-destructive/10 px-6 py-2 text-xs text-destructive-foreground">
            Failed to load traces: {error}
          </div>
        )}
        <div
          className={cn(
            'flex flex-1 overflow-hidden',
            sidebarCollapsed && 'pt-10',
          )}
        >
          <ConversationDetail
            conversation={selected}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
            onCloseSpan={() => setSelectedSpan(null)}
            loading={loading}
          />
        </div>
      </main>
    </div>
  );
}

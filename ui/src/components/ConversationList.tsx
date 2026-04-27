import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Copy, Folder, FolderOpen } from 'lucide-react';
import { cn, formatRelativeTime, formatTimestamp } from '@/lib/utils';
import { getFirstAssistantPreview, selectConversationPreview } from '@/lib/conversation';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { ConversationSummary } from '@/types';

interface Props {
  conversations: ConversationSummary[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

interface ProjectGroup {
  cwd: string | null;
  label: string;
  conversations: ConversationSummary[];
}

const UNKNOWN_KEY = '__unknown__';
const UNKNOWN_LABEL = 'unknown';

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function parentName(cwd: string): string | null {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function groupKey(group: ProjectGroup): string {
  return group.cwd ?? UNKNOWN_KEY;
}

// Pure: partition conversations by cwd, sort groups by most-recent endMs,
// disambiguate colliding basenames with the parent directory. Null-cwd
// conversations land in a single "unknown" group, sorted last.
function groupByProject(
  conversations: ConversationSummary[],
): ProjectGroup[] {
  const byCwd = new Map<string | null, ConversationSummary[]>();
  for (const c of conversations) {
    const list = byCwd.get(c.cwd);
    if (list) list.push(c);
    else byCwd.set(c.cwd, [c]);
  }

  const baseCounts = new Map<string, number>();
  for (const cwd of byCwd.keys()) {
    if (cwd == null) continue;
    const b = basename(cwd);
    baseCounts.set(b, (baseCounts.get(b) ?? 0) + 1);
  }

  const groups: ProjectGroup[] = [];
  for (const [cwd, convs] of byCwd.entries()) {
    let label: string;
    if (cwd == null) {
      label = UNKNOWN_LABEL;
    } else {
      const b = basename(cwd);
      const collides = (baseCounts.get(b) ?? 0) > 1;
      const parent = collides ? parentName(cwd) : null;
      label = parent ? `${parent}/${b}` : b;
    }
    groups.push({ cwd, label, conversations: convs });
  }

  groups.sort((a, b) => {
    if (a.cwd == null && b.cwd != null) return 1;
    if (a.cwd != null && b.cwd == null) return -1;
    const aEnd = Math.max(...a.conversations.map((c) => c.endMs));
    const bEnd = Math.max(...b.conversations.map((c) => c.endMs));
    return bEnd - aEnd;
  });

  return groups;
}

export function ConversationList({
  conversations,
  selectedSessionId,
  onSelect,
}: Props) {
  const groups = useMemo(() => groupByProject(conversations), [conversations]);

  // Controlled open-state per group, keyed by cwd. Groups default to closed;
  // only user-opened groups (or auto-expanded ones via selection) are persisted.
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({});

  // Auto-expand the group containing the current selection so "jump to
  // session" reveals the active conversation.
  useEffect(() => {
    if (!selectedSessionId) return;
    const target = groups.find((g) =>
      g.conversations.some((c) => c.sessionId === selectedSessionId),
    );
    if (!target) return;
    const key = groupKey(target);
    setOpenByKey((prev) =>
      prev[key] ? prev : { ...prev, [key]: true },
    );
  }, [selectedSessionId, groups]);

  if (conversations.length === 0) {
    return (
      <div className="p-6 text-xs text-muted-foreground">
        No conversations captured yet.
      </div>
    );
  }

  const isOpen = (key: string) => openByKey[key] === true;

  return (
    <div>
      {groups.map((group) => {
        const key = groupKey(group);
        const open = isOpen(key);
        return (
          <Collapsible
            key={key}
            open={open}
            onOpenChange={(next) =>
              setOpenByKey((prev) => ({ ...prev, [key]: next }))
            }
          >
            <CollapsibleTrigger
              title={group.cwd ?? 'No cwd recorded in transcript'}
              className="flex w-full items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent/40"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {open ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{group.label}</span>
              </span>
              <ChevronRight
                className={cn(
                  'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                  open && 'rotate-90',
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
              <ul className="divide-y divide-border">
                {group.conversations.map((c) => {
                  const active = c.sessionId === selectedSessionId;
                  const sidShort = c.sessionId.slice(0, 8);
                  const firstPrompt = selectConversationPreview(c);
                  const label = firstPrompt ?? sidShort;
                  const preview = getFirstAssistantPreview(c);
                  return (
                    <li key={c.sessionId} className="group relative">
                      <button
                        type="button"
                        onClick={() => onSelect(c.sessionId)}
                        title={firstPrompt ?? undefined}
                        className={cn(
                          'w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/40',
                          active && 'bg-accent/30',
                        )}
                        style={
                          active
                            ? { boxShadow: 'inset 3px 0 0 hsl(var(--highlight))' }
                            : undefined
                        }
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={cn(
                              'truncate text-xs min-w-0 flex-1',
                              active ? 'text-highlight' : 'text-foreground',
                              firstPrompt ? 'font-medium' : 'font-mono',
                            )}
                          >
                            {label}
                          </span>
                          {c.isRunning && (
                            <span
                              aria-label="running"
                              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                            />
                          )}
                          <time
                            className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                            title={formatTimestamp(c.endMs)}
                            dateTime={new Date(c.endMs).toISOString()}
                          >
                            {formatRelativeTime(c.endMs)}
                          </time>
                        </div>
                        {preview && (
                          <p className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground/80">
                            {preview}
                          </p>
                        )}
                        {c.errorCount > 0 && (
                          <span className="mt-1 inline-block text-[10px] tabular-nums text-destructive">
                            {c.errorCount} err
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="Copy session ID"
                        title="Copy session ID"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(c.sessionId);
                        }}
                        className="absolute bottom-2 right-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

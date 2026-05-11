import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { type DebugGroup, type DebugRecord, bundleToGroups } from '@/lib/debug-bundle';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface Props {
  harness: string;
  sessionId: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; bundle: unknown };

export function ConversationDebug({ harness, sessionId }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const url =
      `/api/transcript?harness=${encodeURIComponent(harness)}` +
      `&sessionId=${encodeURIComponent(sessionId)}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as unknown;
      })
      .then((bundle) => {
        if (!cancelled) setState({ kind: 'ready', bundle });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'unknown error',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [harness, sessionId]);

  if (state.kind === 'loading') {
    return (
      <section>
        <Header total={null} />
        <div className="rounded-lg border border-border bg-background px-6 py-8 text-xs text-muted-foreground">
          Loading transcript…
        </div>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section>
        <Header total={null} />
        <div className="rounded-lg border border-destructive/40 bg-background px-6 py-4 font-mono text-xs text-destructive">
          Failed to load transcript: {state.message}
        </div>
      </section>
    );
  }

  const groups = bundleToGroups(harness, state.bundle);
  const total = groups.reduce((n, g) => n + g.records.length, 0);

  return (
    <section>
      <Header total={total} />
      <div className="space-y-6">
        {groups.map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: groups order is deterministic from bundleToGroups; titles may collide across subagents of same type
          <RecordList key={i} group={g} />
        ))}
      </div>
    </section>
  );
}

function Header({ total }: { total: number | null }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Debug
      </h2>
      <span className="text-xs text-muted-foreground/70">
        {total === null ? '—' : `${total} record${total === 1 ? '' : 's'} from JSONL`}
      </span>
    </div>
  );
}

function RecordList({ group }: { group: DebugGroup }) {
  const [open, setOpen] = useState(group.defaultOpen ?? false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-baseline justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !open && 'border-b-0',
        )}
      >
        <span className="font-mono text-[12px] font-semibold text-foreground">{group.title}</span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {group.subtitle}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 self-center text-muted-foreground transition-transform duration-150',
            !open && '-rotate-90',
          )}
        />
      </button>
      <Collapsible open={open}>
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
          {group.records.length === 0 ? (
            <div className="px-4 py-3 text-[12px] italic text-muted-foreground">(empty)</div>
          ) : (
            group.records.map((rec, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: transcript records are append-only and rendered in source order; no stable id on raw JSONL record
              <RecordRow key={i} record={rec} index={i} summarize={group.summarize} />
            ))
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function RecordRow({
  record,
  index,
  summarize,
}: {
  record: DebugRecord;
  index: number;
  summarize: DebugGroup['summarize'];
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarize(record), [record, summarize]);
  const json = useMemo(() => JSON.stringify(record, null, 2), [record]);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'group grid w-full grid-cols-[44px_auto_1fr_18px] items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-muted/60',
          open && 'bg-muted/30',
        )}
      >
        <span className="font-mono text-[11px] text-muted-foreground/70">#{index}</span>
        <TypeBadge type={summary.type} />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
          {summary.preview}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            !open && '-rotate-90',
          )}
        />
      </button>
      <Collapsible open={open}>
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border bg-muted/20 px-4 py-3 font-mono text-[11px] leading-relaxed text-foreground">
            {json}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const palette: Record<string, string> = {
    user: 'border-sky-500/40 text-sky-500',
    assistant: 'border-emerald-500/40 text-emerald-500',
    system: 'border-purple-500/40 text-purple-500',
    summary: 'border-violet-500/40 text-violet-500',
    tool: 'border-orange-500/40 text-orange-500',
  };
  const cls = palette[type] ?? 'border-border text-muted-foreground';
  return (
    <Badge
      variant="outline"
      className={cn('font-mono text-[10px] uppercase tracking-[0.08em]', cls)}
    >
      {type}
    </Badge>
  );
}

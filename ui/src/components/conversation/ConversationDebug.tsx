import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface Props {
  sessionId: string;
}

type TranscriptRecord = Record<string, unknown>;

interface SubagentTranscript {
  agentId: string;
  agentType: string | null;
  records: TranscriptRecord[];
}

interface TranscriptBundle {
  main: TranscriptRecord[];
  subagents: SubagentTranscript[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; bundle: TranscriptBundle };

export function ConversationDebug({ sessionId }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as TranscriptBundle;
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
  }, [sessionId]);

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

  const { main, subagents } = state.bundle;
  const total =
    main.length + subagents.reduce((n, sa) => n + sa.records.length, 0);

  return (
    <section>
      <Header total={total} />
      <div className="space-y-6">
        <RecordList
          title="Main transcript"
          subtitle={`${main.length} record${main.length === 1 ? '' : 's'}`}
          records={main}
        />
        {subagents.map((sa) => (
          <RecordList
            key={sa.agentId}
            title={`Subagent ${sa.agentType ?? 'unknown'}`}
            subtitle={`${sa.records.length} record${sa.records.length === 1 ? '' : 's'} · ${sa.agentId}`}
            records={sa.records}
          />
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
        {total === null
          ? '—'
          : `${total} record${total === 1 ? '' : 's'} from JSONL`}
      </span>
    </div>
  );
}

interface RecordListProps {
  title: string;
  subtitle: string;
  records: TranscriptRecord[];
}

function RecordList({ title, subtitle, records }: RecordListProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-baseline justify-between border-b border-border bg-muted/40 px-4 py-2.5">
        <span className="font-mono text-[12px] font-semibold text-foreground">
          {title}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {subtitle}
        </span>
      </div>
      {records.length === 0 ? (
        <div className="px-4 py-3 text-[12px] italic text-muted-foreground">
          (empty)
        </div>
      ) : (
        records.map((rec, i) => (
          <RecordRow key={i} record={rec} index={i} />
        ))
      )}
    </div>
  );
}

function RecordRow({
  record,
  index,
}: {
  record: TranscriptRecord;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarize(record), [record]);
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
        <span className="font-mono text-[11px] text-muted-foreground/70">
          #{index}
        </span>
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
    user: 'border-foreground/30 text-foreground',
    assistant: 'border-emerald-500/40 text-emerald-500',
    system: 'border-amber-500/40 text-amber-500',
    summary: 'border-sky-500/40 text-sky-500',
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

interface Summary {
  type: string;
  preview: string;
}

function summarize(record: TranscriptRecord): Summary {
  const type = String(record.type ?? 'unknown');
  const preview = (() => {
    const message = record.message;
    if (message && typeof message === 'object') {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return collapse(content);
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          const kind = String(b.type ?? '');
          if (kind === 'text' && typeof b.text === 'string') {
            parts.push(collapse(b.text));
          } else if (kind === 'thinking' && typeof b.thinking === 'string') {
            parts.push(`[thinking] ${collapse(b.thinking)}`);
          } else if (kind === 'tool_use') {
            parts.push(`[tool_use ${String(b.name ?? '')}]`);
          } else if (kind === 'tool_result') {
            const tid = String(b.tool_use_id ?? '');
            parts.push(`[tool_result ${tid.slice(0, 12)}…]`);
          } else {
            parts.push(`[${kind}]`);
          }
        }
        return parts.join(' · ');
      }
    }
    if (typeof record.summary === 'string') return collapse(record.summary);
    return Object.keys(record).slice(0, 8).join(', ');
  })();
  return { type, preview };
}

function collapse(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= 200 ? flat : flat.slice(0, 199) + '…';
}

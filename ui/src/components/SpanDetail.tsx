import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  cn,
  formatDuration,
  formatTimestamp,
  formatTokens,
  stripLocalCommandCaveat,
} from '@/lib/utils';
import type { SpanNode } from '@/types';
import { Copy, X } from 'lucide-react';

interface Props {
  span: SpanNode;
  onClose: () => void;
}

const HIGHLIGHT_KEYS = [
  ['agent_trace.prompt', 'Prompt'],
  ['agent_trace.inference.prompt', 'Prompt'],
  ['agent_trace.tool.name', 'Tool'],
  ['agent_trace.tool.input_summary', 'Tool input'],
  ['agent_trace.tool.output_summary', 'Tool output'],
  ['gen_ai.request.model', 'Model'],
  ['agent_trace.subagent.task', 'Subagent task'],
  ['agent_trace.task.description', 'Task description'],
  ['agent_trace.task.status', 'Task status'],
  ['agent_trace.response.stop_reason', 'Stop reason'],
  ['agent_trace.hook.event', 'Hook event'],
  ['agent_trace.hook.name', 'Hook name'],
  ['agent_trace.hook.command', 'Hook command'],
  ['agent_trace.hook.stdout', 'Hook stdout'],
  ['agent_trace.hook.stderr', 'Hook stderr'],
  ['agent_trace.hook.exit_code', 'Hook exit code'],
  ['agent_trace.session.initial_permission_mode', 'Initial permission mode'],
  ['agent_trace.mode.plan_file_path', 'Plan file'],
] as const;

interface TokenSegmentSpec {
  key: string;
  label: string;
  colorClass: string;
}

interface TokenBarSpec {
  label: string;
  segments: TokenSegmentSpec[];
}

const TOKEN_BARS: TokenBarSpec[] = [
  {
    label: 'Input',
    segments: [
      {
        key: 'agent_trace.turn.input_tokens',
        label: 'Input',
        colorClass: 'bg-[var(--tok-fresh)]',
      },
      {
        key: 'agent_trace.turn.cache_read_tokens',
        label: 'Cache read',
        colorClass: 'bg-[var(--tok-cache-read)]',
      },
    ],
  },
  {
    label: 'Output',
    segments: [
      {
        key: 'agent_trace.turn.cache_creation_tokens',
        label: 'Cache create',
        colorClass: 'bg-[var(--tok-cache-write)]',
      },
      {
        key: 'agent_trace.turn.output_tokens',
        label: 'Output',
        colorClass: 'bg-[var(--tok-output)]',
      },
    ],
  },
];

const TOKEN_ATTR_KEYS = [
  ...TOKEN_BARS.flatMap((b) => b.segments.map((s) => s.key)),
  'agent_trace.turn.context_tokens',
];

const ID_KEYS = [
  ['session.id', 'session'],
  ['agent_trace.turn.message_id', 'message'],
] as const;

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function SpanDetail({ span, onClose }: Props) {
  const hasError = span.status?.code === 2;
  const isTurn = span.attributes?.['agent_trace.event_type'] === 'turn';
  const otherAttrs = Object.entries(span.attributes).filter(
    ([k]) =>
      !HIGHLIGHT_KEYS.some(([key]) => key === k) &&
      !ID_KEYS.some(([key]) => key === k) &&
      !(isTurn && TOKEN_ATTR_KEYS.includes(k)),
  );
  const idRows = ID_KEYS.flatMap(([key, label]) => {
    const value = span.attributes[key];
    return typeof value === 'string' && value.length > 0 ? [{ label, value }] : [];
  });

  return (
    <div className="flex flex-col">
      <DetailHeader span={span} hasError={hasError} idRows={idRows} onClose={onClose} />

      <div className="space-y-4 px-4 py-4 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Duration" value={formatDuration(span.durationMs)} />
          <Stat label="Started" value={formatTimestamp(span.startMs)} mono />
        </div>

        {hasError && span.status?.message && <ErrorBanner message={span.status.message} />}

        {isTurn && <TokenPanel span={span} />}

        <HighlightAttrs span={span} />

        {otherAttrs.length > 0 && <OtherAttrs entries={otherAttrs} />}

        {span.events.length > 0 && <EventsList events={span.events} />}
      </div>
    </div>
  );
}

function DetailHeader({
  span,
  hasError,
  idRows,
  onClose,
}: {
  span: SpanNode;
  hasError: boolean;
  idRows: { label: string; value: string }[];
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-mono text-sm font-semibold">{span.name}</h3>
          {hasError && <Badge variant="destructive">error</Badge>}
        </div>
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{span.spanId}</p>
        {idRows.map((row) => (
          <IdRow key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
      <Button size="icon" variant="ghost" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span className="uppercase tracking-wide">{label}</span>
      <span className="truncate">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => navigator.clipboard.writeText(value)}
        className="shrink-0 rounded p-0.5 hover:bg-muted"
      >
        <Copy className="h-3 w-3" />
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
      <div className="text-[10px] font-semibold uppercase text-destructive">Error</div>
      <p className="mt-1 text-destructive-foreground">{message}</p>
    </div>
  );
}

function HighlightAttrs({ span }: { span: SpanNode }) {
  return (
    <>
      {HIGHLIGHT_KEYS.map(([key, label]) => {
        const rawValue = span.attributes[key];
        const value =
          key === 'agent_trace.prompt' &&
          Number(span.attributes['agent_trace.turn.number'] ?? 0) === 1 &&
          typeof rawValue === 'string'
            ? stripLocalCommandCaveat(rawValue)
            : rawValue;
        if (value == null || value === '') return null;
        return <Field key={key} label={label} value={asString(value)} />;
      })}
    </>
  );
}

function OtherAttrs({ entries }: { entries: [string, unknown][] }) {
  return (
    <div>
      <Separator className="my-3" />
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">Attributes</div>
      <dl className="mt-2 space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[1fr_2fr] gap-2">
            <dt className="truncate font-mono text-[10px] text-muted-foreground">
              {k.replace(/^agent_trace\./, '')}
            </dt>
            <dd className="break-all font-mono text-[10px]">{asString(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EventsList({ events }: { events: SpanNode['events'] }) {
  return (
    <div>
      <Separator className="my-3" />
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">Events</div>
      <ul className="mt-2 space-y-1.5">
        {events.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: events are presorted chronologically and don't reorder; no stable id on SpanNode event
          <li key={i} className="rounded border border-border/60 bg-muted/30 p-2">
            <div className="font-mono text-[10px]">{e.name}</div>
            {e.attributes && Object.keys(e.attributes).length > 0 && (
              <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                {asString(e.attributes)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TokenPanel({ span }: { span: SpanNode }) {
  const bars = TOKEN_BARS.map((bar) => {
    const segments = bar.segments.map((seg) => {
      const raw = span.attributes[seg.key];
      const value = typeof raw === 'number' ? raw : 0;
      return { ...seg, value };
    });
    const total = segments.reduce((acc, s) => acc + s.value, 0);
    return { label: bar.label, segments, total };
  });
  if (bars.every((b) => b.total === 0)) return null;
  const maxTotal = Math.max(...bars.map((b) => b.total), 1);
  const legendItems = TOKEN_BARS.flatMap((b) => b.segments);

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">Context</div>
      <TooltipProvider delayDuration={150}>
        <div className="mt-2 space-y-2">
          {bars.map((b) => (
            <TokenBar key={b.label} {...b} maxTotal={maxTotal} />
          ))}
        </div>
      </TooltipProvider>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
        {legendItems.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 shrink-0 rounded-sm', s.colorClass)} />
            <span className="text-[10px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface TokenBarProps {
  label: string;
  segments: Array<TokenSegmentSpec & { value: number }>;
  total: number;
  maxTotal: number;
}

function TokenBar({ label, segments, total, maxTotal }: TokenBarProps) {
  // Shared scale: the row for maxTotal fills the full track; smaller rows
  // occupy a proportional fraction of the track, leaving empty space on the
  // right as a visual "how much smaller" reference.
  const rowWidthPct = total > 0 ? (total / maxTotal) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase text-muted-foreground">{label}</span>
      <div className="relative h-4 flex-1 min-w-0 overflow-hidden rounded-sm bg-muted/40">
        <div className="flex h-full" style={{ width: `${rowWidthPct}%` }}>
          {total > 0 &&
            segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <Tooltip key={s.key}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn('h-full cursor-default', s.colorClass)}
                      style={{ width: `${(s.value / total) * 100}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    <span className="font-semibold">{s.label}:</span> {s.value.toLocaleString()}{' '}
                    tokens
                  </TooltipContent>
                </Tooltip>
              ))}
        </div>
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[11px]">{formatTokens(total)}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={mono ? 'mt-0.5 font-mono text-[11px]' : 'mt-0.5 text-xs tabular-nums'}>
        {value}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/30 p-2 text-[11px]">
        {value}
      </pre>
    </div>
  );
}

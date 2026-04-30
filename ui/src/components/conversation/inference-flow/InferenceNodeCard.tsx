import { Brain, MessageSquare, Wrench } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SpanNode } from '@/types';
import { fmt } from '../format';
import {
  totalTokens,
  type InferenceNode,
  type InferenceTokens,
} from './transforms';

interface Props {
  node: InferenceNode;
  demoted?: boolean;
  onSelect?: (span: SpanNode) => void;
}

const TOK_SEGMENTS: Array<{
  key: keyof InferenceTokens;
  label: string;
  cssVar: string;
}> = [
  { key: 'input', label: 'Fresh input', cssVar: '--tok-fresh' },
  { key: 'cacheRead', label: 'Cache read', cssVar: '--tok-cache-read' },
  { key: 'cacheCreation', label: 'Cache write', cssVar: '--tok-cache-write' },
  { key: 'output', label: 'Output', cssVar: '--tok-output' },
];

function StackedBar({ tokens }: { tokens: InferenceTokens }) {
  const total = totalTokens(tokens);
  if (total <= 0) {
    return (
      <div className="h-1.5 w-full rounded-full bg-muted/40" aria-hidden="true" />
    );
  }
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40"
      aria-hidden="true"
    >
      {TOK_SEGMENTS.map(({ key, cssVar }) => {
        const v = tokens[key];
        if (v <= 0) return null;
        return (
          <span
            key={key}
            style={{ flex: `${v} 0 0`, background: `var(${cssVar})` }}
          />
        );
      })}
    </div>
  );
}

function shortModel(model: string | null): string {
  if (!model) return '—';
  // claude-sonnet-4-5-20250929 → sonnet-4.5
  const m = model.match(/claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i);
  if (m) {
    const minor = m[3] ? `.${m[3]}` : '';
    return `${m[1].toLowerCase()}-${m[2]}${minor}`;
  }
  return model.length > 18 ? model.slice(0, 17) + '…' : model;
}

function modelTone(model: string | null): string {
  if (!model) return 'border-border text-muted-foreground';
  const lower = model.toLowerCase();
  if (lower.includes('opus'))
    return 'border-rose-500/40 text-rose-500';
  if (lower.includes('sonnet'))
    return 'border-emerald-500/40 text-emerald-500';
  if (lower.includes('haiku'))
    return 'border-sky-500/40 text-sky-500';
  return 'border-border text-muted-foreground';
}

function stopReasonTone(reason: string | null): string {
  switch (reason) {
    case 'end_turn':
      return 'bg-emerald-500/10 text-emerald-500';
    case 'tool_use':
      return 'bg-violet-500/10 text-violet-500';
    case 'max_tokens':
      return 'bg-amber-500/10 text-amber-500';
    case 'pause_turn':
      return 'bg-sky-500/10 text-sky-500';
    case 'refusal':
      return 'bg-rose-500/10 text-rose-500';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function KindDot({
  active,
  Icon,
  label,
}: {
  active: boolean;
  Icon: typeof Brain;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded',
            active
              ? 'bg-foreground/10 text-foreground'
              : 'text-muted-foreground/30',
          )}
          aria-label={`${label} ${active ? 'present' : 'absent'}`}
        >
          <Icon className="h-2.5 w-2.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {label} {active ? 'present' : 'absent'}
      </TooltipContent>
    </Tooltip>
  );
}

export function InferenceNodeCard({ node, demoted, onSelect }: Props) {
  if (node.isSynthetic) {
    return <SyntheticNodeCard node={node} onSelect={onSelect} />;
  }
  const total = totalTokens(node.tokens);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(node.span)}
      className={cn(
        'group relative flex w-full flex-col gap-1.5 rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/40',
        demoted ? 'border-dashed border-violet-500/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'shrink-0 font-mono text-[10px] tabular-nums',
            demoted ? 'text-violet-500/80' : 'text-muted-foreground/70',
          )}
        >
          #{node.ordinal}
        </span>
        <span
          className={cn(
            'truncate rounded border px-1 font-mono text-[10px]',
            modelTone(node.model),
          )}
        >
          {shortModel(node.model)}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {node.durationMs > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {fmt.ms(node.durationMs)}
            </span>
          )}
          {node.stopReason && (
            <span
              className={cn(
                'rounded px-1 font-mono text-[9px] uppercase tracking-[0.04em]',
                stopReasonTone(node.stopReason),
              )}
            >
              {node.stopReason}
            </span>
          )}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <StackedBar tokens={node.tokens} />
            <div className="mt-0.5 flex items-center justify-between font-mono text-[9.5px] text-muted-foreground/70">
              <span>
                {fmt.n(
                  node.tokens.input +
                    node.tokens.cacheRead +
                    node.tokens.cacheCreation,
                )}{' '}
                in
              </span>
              <span>{fmt.n(node.tokens.output)} out</span>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="px-3 py-2">
          <div className="flex flex-col gap-1">
            {TOK_SEGMENTS.map(({ key, label, cssVar }) => (
              <div key={key} className="flex items-center gap-3 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ background: `var(${cssVar})` }}
                />
                <span className="flex-1 text-muted-foreground">{label}</span>
                <span className="font-mono tabular-nums">
                  {fmt.n(node.tokens[key])}
                </span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between border-t border-border/40 pt-1 text-[11px] font-medium">
              <span>Total</span>
              <span className="font-mono">{fmt.n(total)}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
      <div className="flex items-center gap-1">
        <KindDot active={node.has.thinking} Icon={Brain} label="Thinking" />
        <KindDot active={node.has.text} Icon={MessageSquare} label="Text" />
        <KindDot active={node.has.tool_use} Icon={Wrench} label="Tool use" />
        {node.requestId && (
          <span className="ml-auto truncate font-mono text-[9px] text-muted-foreground/40">
            {node.requestId.slice(0, 8)}
          </span>
        )}
      </div>
    </button>
  );
}

function SyntheticNodeCard({
  node,
  onSelect,
}: {
  node: InferenceNode;
  onSelect?: (span: SpanNode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(node.span)}
      className="flex w-full items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
    >
      <span className="font-mono text-[10px] text-muted-foreground/70">
        #{node.ordinal}
      </span>
      <span className="rounded border border-violet-500/30 px-1 font-mono text-[10px] text-violet-500">
        slash
      </span>
      <span className="truncate font-mono text-[11px] text-foreground">
        {node.syntheticLabel ?? '/(no prompt)'}
      </span>
    </button>
  );
}

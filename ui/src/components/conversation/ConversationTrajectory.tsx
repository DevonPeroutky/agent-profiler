import { useMemo, useState, type ReactNode } from 'react';
import { Brain, Check, ChevronDown, Copy, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ConversationSummary, SpanNode } from '@/types';
import { fmt } from './format';
import { toolTone } from './inference-flow/tool-tone';
import {
  buildTrajectorySteps,
  type InferenceUsage,
  type StepTokens,
  type TrajectoryEntry,
  type TrajectoryInference,
  type TrajectoryStep,
} from './transforms';

interface Props {
  conversation: ConversationSummary;
}

export function ConversationTrajectory({ conversation }: Props) {
  const steps = useMemo(
    () => buildTrajectorySteps(conversation),
    [conversation],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (steps.length === 0) {
    return (
      <section>
        <Header count={0} />
        <div className="rounded-lg border border-border bg-background px-6 py-8 text-xs text-muted-foreground">
          No steps captured for this conversation yet.
        </div>
      </section>
    );
  }

  const maxDuration = steps.reduce((m, s) => Math.max(m, s.durationMs), 0);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <TooltipProvider delayDuration={150}>
      <section>
        <Header count={steps.length} />
        <StepBar steps={steps} maxDuration={maxDuration} />
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          {steps.map((s) => (
            <TrajectoryRow
              key={s.id}
              step={s}
              isOpen={expanded.has(s.id)}
              onToggle={() => toggle(s.id)}
            />
          ))}
        </div>
      </section>
    </TooltipProvider>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Trajectory
      </h2>
      <span className="text-xs text-muted-foreground/70">
        {count} step{count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

function StepBar({
  steps,
  maxDuration,
}: {
  steps: TrajectoryStep[];
  maxDuration: number;
}) {
  return (
    <div
      className="mb-3 flex h-7 w-full overflow-hidden rounded-md border border-border bg-muted/40"
      role="img"
      aria-label={`${steps.length} step trajectory`}
    >
      {steps.map((s) => {
        const flexBasis = Math.max(s.durationMs, 250);
        const intensity =
          maxDuration > 0 ? Math.min(1, s.durationMs / maxDuration) : 0;
        const background =
          s.role === 'user'
            ? 'var(--tool-user, hsl(220 70% 60%))'
            : `hsl(220 8% ${Math.round(72 - intensity * 50)}%)`;
        return (
          <Tooltip key={s.id}>
            <TooltipTrigger asChild>
              <span
                className="block h-full cursor-pointer border-r border-background/60 last:border-r-0"
                style={{ flex: `${flexBasis} 1 0`, background }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px]">
              <div className="font-medium">
                #{s.index} · {s.role}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {s.durationMs > 0 ? fmt.ms(s.durationMs) : '—'}
              </div>
              {s.preview && (
                <div className="mt-1 line-clamp-2 text-[12px] text-muted-foreground">
                  {s.preview}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

interface RowProps {
  step: TrajectoryStep;
  isOpen: boolean;
  onToggle: () => void;
}

const userAvatarIcon = <User className="h-3.5 w-3.5" aria-hidden="true" />;
const claudeAvatarIcon = (
  <img
    src="/images/claude-logo.png"
    alt=""
    className="h-6 w-6 object-contain"
    aria-hidden="true"
  />
);

function TrajectoryRow({ step, isOpen, onToggle }: RowProps) {
  const isUser = step.role === 'user';
  const innerCells = (
    <>
      <span className="font-mono text-[11px] text-muted-foreground/70">
        #{step.index}
      </span>
      {isUser ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {userAvatarIcon}
        </span>
      ) : (
        <Avatar className="h-6 w-6 bg-background">
          <AvatarFallback className="bg-background">
            {claudeAvatarIcon}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            'text-[10px] uppercase tracking-[0.08em]',
            isUser
              ? 'border-foreground/30 text-foreground'
              : 'border-emerald-500/40 text-emerald-500',
          )}
        >
          {isUser ? 'user' : (step.model ?? 'agent')}
        </Badge>
      </span>
      <span className="min-w-0 truncate text-[13px] text-foreground">
        {step.preview || (
          <span className="italic text-muted-foreground">(no message)</span>
        )}
      </span>
      <span className="min-w-[48px] text-right font-mono text-[11px] text-muted-foreground/80">
        {step.durationMs > 0 ? fmt.ms(step.durationMs) : ''}
      </span>
      {isUser ? (
        <span aria-hidden="true" className="h-3.5 w-3.5" />
      ) : (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            !isOpen && '-rotate-90',
          )}
        />
      )}
    </>
  );
  return (
    <div className="border-b border-border last:border-b-0">
      {isUser ? (
        <div className="grid w-full grid-cols-[40px_28px_auto_1fr_auto_18px] items-center gap-3 px-3.5 py-2.5">
          {innerCells}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            className={cn(
              'group grid w-full grid-cols-[40px_28px_auto_1fr_auto_18px] items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60',
              isOpen && 'bg-muted/40',
            )}
          >
            {innerCells}
          </button>
          <Collapsible open={isOpen}>
            <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
              <div className="border-t border-border bg-muted/20 px-4 py-3">
                <ExpandedEntries step={step} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}

function isDispatchSpan(span: SpanNode): boolean {
  return span.children.some(
    (c) => c.attributes?.['agent_trace.event_type'] === 'subagent',
  );
}

// Sum across all subagent children. Multiple children occur when a single
// Agent tool call spawned parallel subagents — totals represent the aggregate
// cost of *this dispatch*.
function dispatchSubagentTokens(span: SpanNode): StepTokens | null {
  const kids = span.children.filter(
    (c) => c.attributes?.['agent_trace.event_type'] === 'subagent',
  );
  if (kids.length === 0) return null;
  const num = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const c of kids) {
    input += num(c.attributes['agent_trace.subagent.input_tokens']);
    output += num(c.attributes['agent_trace.subagent.output_tokens']);
    cacheRead += num(c.attributes['agent_trace.subagent.cache_read_tokens']);
    cacheCreation += num(c.attributes['agent_trace.subagent.cache_creation_tokens']);
  }
  if (input + output + cacheRead + cacheCreation === 0) return null;
  return { input, output, cacheRead, cacheCreation };
}

function isSubagentEntry(
  entry: TrajectoryEntry,
  inferences: TrajectoryInference[],
): boolean {
  return inferences[entry.inferenceIdx]?.subagent === true;
}

function ExpandedEntries({ step }: { step: TrajectoryStep }) {
  if (step.entries.length === 0) {
    return (
      <p className="text-[12px] italic text-muted-foreground">(no content)</p>
    );
  }
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < step.entries.length) {
    const entry = step.entries[i];
    if (entry.kind === 'tool' && isDispatchSpan(entry.span)) {
      const nested: TrajectoryEntry[] = [];
      let j = i + 1;
      while (
        j < step.entries.length &&
        isSubagentEntry(step.entries[j], step.inferences)
      ) {
        nested.push(step.entries[j]);
        j++;
      }
      nodes.push(
        <ToolCallBlock key={i} span={entry.span}>
          {nested.length > 0 ? (
            <NestedEntries entries={nested} inferences={step.inferences} />
          ) : null}
        </ToolCallBlock>,
      );
      i = j;
      continue;
    }
    nodes.push(
      <EntryBlock key={i} entry={entry} inferences={step.inferences} />,
    );
    i++;
  }
  return <div className="space-y-2.5">{nodes}</div>;
}

function NestedEntries({
  entries,
  inferences,
}: {
  entries: TrajectoryEntry[];
  inferences: TrajectoryInference[];
}) {
  return (
    <div className="space-y-2.5">
      {entries.map((entry, i) => (
        <EntryBlock key={i} entry={entry} inferences={inferences} />
      ))}
    </div>
  );
}

function EntryBlock({
  entry,
  inferences,
}: {
  entry: TrajectoryEntry;
  inferences: TrajectoryInference[];
}) {
  if (entry.kind === 'message') {
    const tokens = inferences[entry.inferenceIdx]?.tokens;
    return <MessageBlock text={entry.text} tokens={tokens} />;
  }
  if (entry.kind === 'reasoning')
    return <ThinkingBlock text={entry.text} usage={entry.usage} />;
  return <ToolCallBlock span={entry.span} />;
}

const TOK_ROWS: Array<{
  key: 'input' | 'cacheRead' | 'cacheCreation' | 'output';
  label: string;
  cssVar: string;
}> = [
  { key: 'input', label: 'Fresh input', cssVar: '--tok-fresh' },
  { key: 'cacheRead', label: 'Cache read', cssVar: '--tok-cache-read' },
  { key: 'cacheCreation', label: 'Cache write', cssVar: '--tok-cache-write' },
  { key: 'output', label: 'Output', cssVar: '--tok-output' },
];

function MessageBlock({
  text,
  tokens,
}: {
  text: string;
  tokens?: StepTokens;
}) {
  const hasTokens =
    !!tokens &&
    (tokens.input > 0 ||
      tokens.cacheRead > 0 ||
      tokens.cacheCreation > 0 ||
      tokens.output > 0);
  const inputTotal = tokens
    ? tokens.input + tokens.cacheRead + tokens.cacheCreation
    : 0;
  return (
    <div className="flex flex-col">
      <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">
        {text}
      </pre>
      {hasTokens && tokens && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="mt-1 flex cursor-default justify-end font-mono text-[10px] text-muted-foreground/60 hover:text-muted-foreground">
              {fmt.n(inputTotal)} in · {fmt.n(tokens.output)} out
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="px-3 py-2">
            <div className="flex flex-col gap-1">
              {TOK_ROWS.map(({ key, label, cssVar }) => (
                <div
                  key={key}
                  className="flex items-center gap-3 text-[11px]"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: `var(${cssVar})` }}
                  />
                  <span className="flex-1 text-muted-foreground">{label}</span>
                  <span className="font-mono tabular-nums">
                    {fmt.n(tokens[key])}
                  </span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ThinkingBlock({
  text,
  usage,
}: {
  text: string;
  usage: InferenceUsage;
}) {
  const hasUsage =
    usage.outputTokens > 0 ||
    usage.inputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0;
  const inputTotal =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/40 bg-muted/30 px-3 py-2">
      <Brain
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        thinking
      </span>
      {text ? (
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {text}
        </span>
      ) : (
        <span className="flex-1 font-mono text-[11px] italic text-muted-foreground/60">
          encrypted
        </span>
      )}
      {hasUsage && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {fmt.n(inputTotal)} in · {fmt.n(usage.outputTokens)} out
        </span>
      )}
    </div>
  );
}

type ParsedParams =
  | { kind: 'kv'; entries: [string, string][] }
  | { kind: 'text'; text: string };

function parseParams(raw: string): ParsedParams {
  if (!raw) return { kind: 'text', text: '' };
  try {
    const obj = JSON.parse(raw);
    if (
      obj !== null &&
      typeof obj === 'object' &&
      !Array.isArray(obj) &&
      Object.keys(obj).length > 0
    ) {
      const entries: [string, string][] = Object.entries(
        obj as Record<string, unknown>,
      ).map(([k, v]) => [k, formatValue(v)]);
      return { kind: 'kv', entries };
    }
    return { kind: 'text', text: JSON.stringify(obj, null, 2) };
  } catch {
    return { kind: 'text', text: raw };
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  return JSON.stringify(v, null, 2);
}

function truncateText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function skillNameFromInput(inputRaw: string): string | null {
  if (!inputRaw) return null;
  try {
    const obj = JSON.parse(inputRaw);
    if (obj && typeof obj === 'object' && typeof obj.skill === 'string') {
      const name = obj.skill.trim();
      return name || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function dispatchTitleSuffix(
  toolName: string,
  span: SpanNode,
  inputRaw: string,
): string | null {
  // Skill dispatches: prefer the skill name (e.g. "rhino8:design") from the
  // tool input. The synthetic Skill spans for slash commands carry it on
  // `agent_trace.tool.slash_command` instead.
  if (toolName === 'Skill') {
    const slash = span.attributes['agent_trace.tool.slash_command'];
    if (typeof slash === 'string' && slash.trim()) return `/${slash.trim()}`;
    const skill = skillNameFromInput(inputRaw);
    if (skill) return skill;
    // Fall through to subagent.type if no skill name is present.
  }
  const typeAttr = span.attributes['agent_trace.subagent.type'];
  if (typeof typeAttr !== 'string' || !typeAttr.trim()) return null;
  const type = typeAttr.trim();
  const descAttr = span.attributes['agent_trace.subagent.description'];
  const desc =
    typeof descAttr === 'string' && descAttr.trim() ? descAttr.trim() : '';
  return desc ? `${type}: ${truncateText(desc, 60)}` : type;
}

function ToolCallBlock({
  span,
  children,
}: {
  span: SpanNode;
  children?: ReactNode;
}) {
  const name =
    String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
  const inputRaw = String(
    span.attributes['agent_trace.tool.input_summary'] ?? '',
  );
  const outputRaw = String(
    span.attributes['agent_trace.tool.output_summary'] ?? '',
  );
  const tone = toolTone(name);
  const params = parseParams(inputRaw);
  const subagentSuffix = dispatchTitleSuffix(name, span, inputRaw);
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn('overflow-hidden rounded-md border bg-background', tone.border)}
    >
      <div
        className={cn(
          'flex items-center justify-between px-3 py-1.5',
          tone.headerBg,
          open && 'border-b',
          open && tone.border,
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px] font-medium"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              !open && '-rotate-90',
            )}
          />
          <span
            className={cn(
              'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-1 text-[9px] font-bold',
              tone.badge,
            )}
          >
            {tone.glyph}
          </span>
          <span className={cn('shrink-0', tone.headerText)}>{name}</span>
          {subagentSuffix && (
            <span className="min-w-0 truncate text-muted-foreground/80">
              · {subagentSuffix}
            </span>
          )}
        </button>
        <div className="flex items-center gap-3">
          <DispatchTokenChip span={span} />
          <ToolMeta span={span} />
        </div>
      </div>
      <Collapsible open={open}>
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
          <div className="space-y-3 px-3 py-3">
            <DispatchTokenOverview span={span} />
            <ToolSection label="Input" copyText={inputRaw}>
              {params.kind === 'kv' ? (
                <dl className="space-y-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[11.5px]">
                  {params.entries.map(([k, v], i) => (
                    <div key={i} className="space-y-1">
                      <dt className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                        {k}
                      </dt>
                      <dd className="whitespace-pre-wrap break-words font-mono text-foreground">
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-foreground">
                  {params.kind === 'text' && params.text ? params.text : '—'}
                </pre>
              )}
            </ToolSection>
            <ToolSection
              label="Output"
              copyText={outputRaw || undefined}
              collapsible
            >
              <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-foreground">
                {outputRaw || '—'}
              </pre>
            </ToolSection>
          </div>
          {children !== undefined && children !== null && (
            <div className={cn('border-t px-3 py-3', tone.border)}>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                Subagent activity
              </div>
              {children}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ToolSection({
  label,
  copyText,
  collapsible = false,
  children,
}: {
  label: string;
  copyText?: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                !open && '-rotate-90',
              )}
            />
            <span>{label}</span>
          </button>
        ) : (
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {label}
          </span>
        )}
        {copyText && <CopyButton text={copyText} />}
      </div>
      {open && children}
    </div>
  );
}

function ToolMeta({ span }: { span: SpanNode }) {
  const ms = span.durationMs;
  const bytesAttr = span.attributes['agent_trace.tool.output_bytes'];
  const bytes =
    typeof bytesAttr === 'number' && Number.isFinite(bytesAttr) ? bytesAttr : 0;
  if (ms <= 0 && bytes <= 0) return null;
  return (
    <div className="mr-1 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
      {ms > 0 && <span>{fmt.ms(ms)}</span>}
      {bytes > 0 && <span>· {fmt.bytes(bytes)}</span>}
    </div>
  );
}

function DispatchTokenChip({ span }: { span: SpanNode }) {
  const tokens = dispatchSubagentTokens(span);
  if (!tokens) return null;
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return (
    <span className="font-mono text-[10.5px] text-muted-foreground">
      {fmt.n(inputTotal)} in · {fmt.n(tokens.output)} out
    </span>
  );
}

function DispatchTokenOverview({ span }: { span: SpanNode }) {
  const tokens = dispatchSubagentTokens(span);
  if (!tokens) return null;
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Subagent context
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmt.n(inputTotal)} in · {fmt.n(tokens.output)} out
        </span>
      </div>
      <dl className="grid grid-cols-4 gap-3">
        {TOK_ROWS.map(({ key, label, cssVar }) => (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: `var(${cssVar})` }}
              />
              <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
                {label}
              </span>
            </div>
            <span className="font-mono text-[12px] tabular-nums text-foreground">
              {fmt.n(tokens[key])}
            </span>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onCopy}
      className="h-6 w-6 text-muted-foreground hover:text-foreground"
      aria-label={copied ? 'Copied' : 'Copy'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}

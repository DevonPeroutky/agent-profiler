import { useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, Lock, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ConversationSummary, SpanNode } from '@/types';
import { fmt } from './format';
import { buildTrajectorySteps, type TrajectoryStep } from './transforms';

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

  const baseStartMs = steps[0].startMs;
  const maxDuration = steps.reduce((m, s) => Math.max(m, s.durationMs), 0);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section>
      <Header count={steps.length} />
      <StepBar steps={steps} maxDuration={maxDuration} />
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {steps.map((s) => (
          <TrajectoryRow
            key={s.id}
            step={s}
            baseStartMs={baseStartMs}
            isOpen={expanded.has(s.id)}
            onToggle={() => toggle(s.id)}
          />
        ))}
      </div>
    </section>
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
          <span
            key={s.id}
            className="block h-full border-r border-background/60 last:border-r-0"
            style={{ flex: `${flexBasis} 1 0`, background }}
            title={`#${s.index} · ${s.role}${s.durationMs > 0 ? ' · ' + fmt.ms(s.durationMs) : ''}`}
          />
        );
      })}
    </div>
  );
}

interface RowProps {
  step: TrajectoryStep;
  baseStartMs: number;
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

function TrajectoryRow({ step, baseStartMs, isOpen, onToggle }: RowProps) {
  const cumulativeMs = Math.max(0, step.startMs - baseStartMs);
  const isUser = step.role === 'user';
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn(
          'group grid w-full grid-cols-[40px_28px_auto_1fr_auto_auto_18px] items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60',
          isOpen && 'bg-muted/40',
        )}
      >
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
            {isUser ? 'user' : 'agent'}
          </Badge>
          {step.model && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {step.model}
            </span>
          )}
        </span>
        <span className="min-w-0 truncate text-[13px] text-foreground">
          {step.preview || (
            <span className="italic text-muted-foreground">(no message)</span>
          )}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/80">
          {step.durationMs > 0 ? '+' + fmt.ms(step.durationMs) : ''}
        </span>
        <span className="min-w-[48px] text-right font-mono text-[11px] text-muted-foreground/70">
          {fmt.ms(cumulativeMs) || '0s'}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
            !isOpen && '-rotate-90',
          )}
        />
      </button>
      <Collapsible open={isOpen}>
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
          <div className="space-y-3 border-t border-border bg-muted/20 px-4 py-3">
            {step.segments.map((seg, idx) =>
              seg.kind === 'message' ? (
                <pre
                  key={idx}
                  className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground"
                >
                  {seg.text}
                </pre>
              ) : (
                <ReasoningMarker key={idx} />
              ),
            )}
            {step.toolCalls.length > 0 && (
              <Section title="Tool Calls">
                <div className="space-y-2">
                  {step.toolCalls.map((span) => (
                    <ToolCallBlock key={span.spanId} span={span} />
                  ))}
                </div>
              </Section>
            )}
            {step.segments.length === 0 && step.toolCalls.length === 0 && (
              <p className="text-[12px] italic text-muted-foreground">
                (no content)
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ReasoningMarker() {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-muted-foreground/40 bg-muted/40 px-2 py-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
      <Lock className="h-3 w-3" aria-hidden="true" />
      <span>thinking</span>
      <span className="text-muted-foreground/60">· encrypted</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function ToolCallBlock({ span }: { span: SpanNode }) {
  const name =
    String(span.attributes['agent_trace.tool.name'] ?? span.name) || 'tool';
  const inputRaw = String(span.attributes['agent_trace.tool.input_summary'] ?? '');
  const formatted = formatJson(inputRaw);
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-sky-500">
          {name}
        </span>
        <CopyButton text={formatted} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground">
        {formatted || '—'}
      </pre>
    </div>
  );
}

function formatJson(s: string): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
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

import { Fragment, useMemo, useState } from 'react';
import type { ConversationSummary } from '@/types';
import {
  buildConversationSteps,
  type ConversationStep,
  type ConversationStepKind,
  type StepTokens,
} from './transforms';

interface Props {
  conversation: ConversationSummary;
}

interface KindMeta {
  label: string;
  color: string;
  glyph: string;
  fg?: string;
}

const KIND_META: Record<ConversationStepKind, KindMeta> = {
  'user-prompt': {
    label: 'User prompt',
    color: 'var(--tool-user)',
    glyph: 'U',
  },
  inference: {
    label: 'Inference',
    color: 'var(--tool-inference)',
    glyph: '∞',
  },
  tool: { label: 'Tool', color: 'var(--tool-bash)', glyph: '$' },
  'assistant-message': {
    label: 'Assistant message',
    color: 'var(--tok-output)',
    glyph: 'A',
  },
};

const TOOL_KIND_META: Record<string, Partial<KindMeta>> = {
  Read: { color: 'var(--tool-read)', glyph: 'R' },
  Write: { color: 'var(--tool-write)', glyph: 'W' },
  Bash: { color: '#0a0a0a', glyph: '>_', fg: '#4ade80' },
  Search: { color: 'var(--tool-search)', glyph: 'S' },
  Subagent: { color: 'var(--tool-subagent)', glyph: 'A' },
  'MCP tool': { color: 'var(--tool-search)', glyph: 'M' },
  Tool: { color: 'var(--tool-bash)', glyph: 'T' },
};

function metaFor(step: ConversationStep): KindMeta {
  if (step.kind !== 'tool') return KIND_META[step.kind];
  const sub = step.subtitle;
  const override = TOOL_KIND_META[sub];
  return {
    label: sub,
    color: override?.color ?? KIND_META.tool.color,
    glyph: override?.glyph ?? KIND_META.tool.glyph,
    fg: override?.fg,
  };
}

const fmt = {
  n(x: number): string {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    if (x < 1000) return String(x);
    if (x < 1e6)
      return (
        (x / 1000).toFixed(x < 10000 ? 2 : 1).replace(/\.0+$/, '') + 'k'
      );
    return (x / 1e6).toFixed(2) + 'M';
  },
  pct(x: number): string {
    return (x * 100).toFixed(1) + '%';
  },
  ms(ms: number): string {
    if (ms === 0) return '';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return m + 'm ' + String(s).padStart(2, '0') + 's';
  },
};

function totalTokens(t: StepTokens): number {
  return t.input + t.cacheRead + t.cacheCreation + t.output;
}

interface CumStep extends ConversationStep {
  cumInput: number;
  cumOutput: number;
  cumTotal: number;
}

function withCumulative(steps: ConversationStep[]): CumStep[] {
  let cumInput = 0;
  let cumOutput = 0;
  return steps.map((s) => {
    cumInput += s.tokens.input + s.tokens.cacheRead + s.tokens.cacheCreation;
    cumOutput += s.tokens.output;
    return {
      ...s,
      cumInput,
      cumOutput,
      cumTotal: cumInput + cumOutput,
    };
  });
}

export function ConversationSteps({ conversation }: Props) {
  const steps = useMemo(
    () => withCumulative(buildConversationSteps(conversation)),
    [conversation],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = steps.find((s) => s.id === selectedId) ?? null;

  if (steps.length === 0) return null;

  const turnCount = new Set(
    steps.filter((s) => s.turnNumber !== null).map((s) => s.turnNumber),
  ).size;

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Steps
        </h2>
        <span className="text-xs text-muted-foreground/70">
          {steps.length} step{steps.length === 1 ? '' : 's'} · {turnCount} turn
          {turnCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <StepList
          steps={steps}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <StepDetail step={selected} steps={steps} />
      </div>
    </section>
  );
}

interface StepListProps {
  steps: CumStep[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function StepList({ steps, selectedId, onSelect }: StepListProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {steps.map((s, i) => {
        const next = steps[i + 1];
        const dividerBeforeNext =
          next !== undefined && next.turnNumber !== s.turnNumber;
        const dividerHere = i > 0 && steps[i - 1]?.turnNumber !== s.turnNumber;
        return (
          <Fragment key={s.id}>
            {dividerHere && <TurnDivider turnNumber={s.turnNumber} />}
            <StepRow
              step={s}
              isSelected={s.id === selectedId}
              onSelect={() => onSelect(s.id)}
              hideBottomBorder={dividerBeforeNext}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

function TurnDivider({ turnNumber }: { turnNumber: number | null }) {
  const label = turnNumber !== null ? `Turn ${turnNumber}` : 'Unattached';
  return (
    <div className="flex items-center gap-3 bg-muted/30">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

interface StepRowProps {
  step: CumStep;
  isSelected: boolean;
  onSelect: () => void;
  hideBottomBorder?: boolean;
}

function StepRow({ step, isSelected, onSelect, hideBottomBorder }: StepRowProps) {
  const meta = metaFor(step);
  const inputTok = step.tokens.input + step.tokens.cacheRead + step.tokens.cacheCreation;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        'grid w-full grid-cols-[36px_22px_1fr_auto_auto] items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-muted ' +
        (hideBottomBorder ? '' : 'border-b border-border last:border-b-0 ') +
        (isSelected ? 'bg-muted' : '')
      }
    >
      <span className="font-mono text-[11px] text-muted-foreground/70">
        {step.turnNumber !== null ? `T${step.turnNumber}` : '—'}
      </span>
      <span
        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded font-mono text-[10px] font-semibold tracking-tighter"
        style={{ background: meta.color, color: meta.fg ?? '#fff' }}
      >
        {meta.glyph}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-foreground">
          {step.label}
        </span>
        <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
          {meta.label}
          {step.durationMs > 0 ? ' · ' + fmt.ms(step.durationMs) : ''}
        </span>
      </span>
      <span className="flex gap-2.5 font-mono text-[11.5px] text-muted-foreground">
        {inputTok > 0 && (
          <span>
            <span className="text-muted-foreground/60">→ </span>
            {fmt.n(inputTok)}
          </span>
        )}
        {step.tokens.output > 0 && (
          <span>
            <span className="text-muted-foreground/60">← </span>
            {fmt.n(step.tokens.output)}
          </span>
        )}
      </span>
      <span className="min-w-[66px] text-right font-mono text-[11px] text-muted-foreground/70">
        Σ {fmt.n(step.cumTotal)}
      </span>
    </button>
  );
}

interface StepDetailProps {
  step: CumStep | null;
  steps: CumStep[];
}

function StepDetail({ step, steps }: StepDetailProps) {
  if (!step) {
    return (
      <div className="sticky top-20 overflow-hidden rounded-lg border border-border bg-background">
        <div className="border-b border-border bg-muted px-4 py-3.5">
          <div className="text-[13px] font-semibold">Step details</div>
          <div className="mt-1 font-mono text-[11.5px] text-muted-foreground">
            Click any step to inspect
          </div>
        </div>
        <div className="px-5 py-10 text-center text-[12.5px] text-muted-foreground/70">
          Select a step from the list.
        </div>
      </div>
    );
  }
  const meta = metaFor(step);
  const stepInput =
    step.tokens.input + step.tokens.cacheRead + step.tokens.cacheCreation;
  const stepTotal = stepInput + step.tokens.output;
  const grand = steps[steps.length - 1]?.cumTotal ?? 0;
  const pctOfTotal = grand === 0 ? 0 : (stepTotal / grand) * 100;
  const segments: Array<{ key: string; value: number; color: string; label: string }> = [
    { key: 'fresh', value: step.tokens.input, color: 'var(--tok-fresh)', label: 'Fresh input' },
    { key: 'cacheRead', value: step.tokens.cacheRead, color: 'var(--tok-cache-read)', label: 'Cache read' },
    { key: 'cacheWrite', value: step.tokens.cacheCreation, color: 'var(--tok-cache-write)', label: 'Cache write' },
    { key: 'output', value: step.tokens.output, color: 'var(--tok-output)', label: 'Output' },
  ].filter((s) => s.value > 0);

  return (
    <div className="sticky top-20 flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="border-b border-border bg-muted px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-[18px] w-[18px] items-center justify-center rounded font-mono text-[10px] font-semibold tracking-tighter"
            style={{ background: meta.color, color: meta.fg ?? '#fff' }}
          >
            {meta.glyph}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">
              {step.label}
            </div>
            <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
              {meta.label}
              {step.turnNumber !== null ? ` · Turn ${step.turnNumber}` : ' · Unattached'}
              {step.durationMs > 0 ? ` · ${fmt.ms(step.durationMs)}` : ''}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <SectionTitle>Token flow</SectionTitle>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border">
          <TokCell label="Input (this step)" value={fmt.n(stepInput)} unit="tok" />
          <TokCell
            label="Output (this step)"
            value={fmt.n(step.tokens.output)}
            unit="tok"
          />
          <TokCell
            label="Context size Σ"
            value={fmt.n(step.cumInput)}
            unit="tok"
          />
          <TokCell
            label="% of total run"
            value={pctOfTotal.toFixed(2)}
            unit="%"
          />
        </div>
        {stepTotal > 0 && segments.length > 0 && (
          <>
            <SectionTitle>Composition</SectionTitle>
            <div className="flex h-2.5 overflow-hidden rounded bg-muted">
              {segments.map((seg) => (
                <span
                  key={seg.key}
                  className="block h-full"
                  style={{
                    width: `${(seg.value / stepTotal) * 100}%`,
                    background: seg.color,
                  }}
                />
              ))}
            </div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
              {segments.map((seg) => (
                <RowKv
                  key={seg.key}
                  swatch={seg.color}
                  k={seg.label}
                  v={`${fmt.n(seg.value)} (${((seg.value / stepTotal) * 100).toFixed(1)}%)`}
                />
              ))}
            </dl>
          </>
        )}
        <SectionTitle>Cumulative after this step</SectionTitle>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
          <RowKv k="Input Σ" v={fmt.n(step.cumInput)} />
          <RowKv k="Output Σ" v={fmt.n(step.cumOutput)} />
          <RowKv k="Grand total Σ" v={fmt.n(step.cumTotal)} />
        </dl>
        <SectionTitle>Details</SectionTitle>
        <StepPayload step={step} />
      </div>
    </div>
  );
}

function StepPayload({ step }: { step: CumStep }) {
  if (step.kind === 'user-prompt' || step.kind === 'assistant-message') {
    return <PreBlock>{step.text ?? ''}</PreBlock>;
  }
  if (step.kind === 'inference') {
    const stop =
      step.span?.attributes['agent_trace.response.stop_reason'] ?? '';
    const model = step.span?.attributes['gen_ai.request.model'] ?? '';
    const requestId =
      step.span?.attributes['agent_trace.inference.request_id'] ?? '';
    return (
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
        <RowKv k="model" v={String(model) || '—'} />
        <RowKv k="stop reason" v={String(stop) || '—'} />
        <RowKv k="request id" v={String(requestId) || '—'} />
      </dl>
    );
  }
  // tool
  const input = step.span?.attributes['agent_trace.tool.input_summary'] ?? '';
  const output = step.span?.attributes['agent_trace.tool.output_summary'] ?? '';
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/80">
          Input
        </div>
        <PreBlock>{String(input) || '—'}</PreBlock>
      </div>
      <div>
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/80">
          Output
        </div>
        <PreBlock>{String(output) || '—'}</PreBlock>
      </div>
    </div>
  );
}

function PreBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-[11.5px] leading-[1.55]">
      {children}
    </pre>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

function TokCell({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="bg-background px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-[16px] font-medium">
        {value}
        {unit ? (
          <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">
            {unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RowKv({
  k,
  v,
  swatch,
}: {
  k: string;
  v: string;
  swatch?: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">
        {swatch ? (
          <span
            className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle"
            style={{ background: swatch }}
          />
        ) : null}
        {k}
      </dt>
      <dd className="font-mono text-foreground">{v}</dd>
    </>
  );
}

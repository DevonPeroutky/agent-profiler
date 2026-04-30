import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { fmt } from '../format';
import {
  totalTokens,
  type InferenceFlowModel,
  type InferenceTokens,
  type SubagentTotals,
} from './transforms';

interface Props {
  model: InferenceFlowModel;
}

const SEGMENTS: Array<{
  key: keyof InferenceTokens;
  label: string;
  cssVar: string;
}> = [
  { key: 'input', label: 'Fresh in', cssVar: '--tok-fresh' },
  { key: 'cacheRead', label: 'Cache read', cssVar: '--tok-cache-read' },
  { key: 'cacheCreation', label: 'Cache write', cssVar: '--tok-cache-write' },
  { key: 'output', label: 'Output', cssVar: '--tok-output' },
];

export function InferenceFlowHeader({ model }: Props) {
  const mainCount = model.branches.get('main')?.length ?? 0;
  const totalSpurs = Array.from(model.branches.keys()).filter(
    (k) => k !== 'main' && !k.startsWith('unattached:'),
  ).length;
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Inference flow
          </h2>
          <span className="font-mono text-[11px] text-muted-foreground/70">
            {mainCount} on main · {totalSpurs} subagent spur
            {totalSpurs === 1 ? '' : 's'}
            {model.unattachedBranchIds.length > 0 &&
              ` · ${model.unattachedBranchIds.length} unattached`}
          </span>
        </div>
        <TokenStrip label="Conversation" tokens={model.conversationTotals} />
      </div>
      {model.perSubagentTotals.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
            Subagents
          </span>
          {model.perSubagentTotals.map((s) => (
            <SubagentChip key={s.type} totals={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function TokenStrip({
  label,
  tokens,
}: {
  label: string;
  tokens: InferenceTokens;
}) {
  const total = totalTokens(tokens);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70">
            {label}
          </span>
          <span className="flex h-1.5 w-32 overflow-hidden rounded-full bg-muted/40">
            {SEGMENTS.map(({ key, cssVar }) => {
              const v = tokens[key];
              if (v <= 0) return null;
              return (
                <span
                  key={key}
                  style={{ flex: `${v} 0 0`, background: `var(${cssVar})` }}
                />
              );
            })}
          </span>
          <span className="font-mono text-[11px] text-foreground">
            {fmt.n(total)} tok
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-3 py-2">
        <div className="flex flex-col gap-1">
          {SEGMENTS.map(({ key, label, cssVar }) => (
            <div key={key} className="flex items-center gap-3 text-[11px]">
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
  );
}

function SubagentChip({ totals }: { totals: SubagentTotals }) {
  const total = totalTokens(totals.tokens);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded border border-violet-500/30 bg-violet-500/[0.06] px-1.5 py-0.5">
          <span className="font-mono text-[10px] text-violet-500">
            {totals.type}
          </span>
          <span className="font-mono text-[9.5px] text-muted-foreground/80">
            ×{totals.count}
          </span>
          <span className="font-mono text-[9.5px] text-foreground/80">
            {fmt.n(total)}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-3 py-2">
        <div className="mb-1 font-mono text-[11px] font-medium text-violet-500">
          {totals.type}
        </div>
        <div className="flex flex-col gap-1">
          {SEGMENTS.map(({ key, label, cssVar }) => (
            <div key={key} className="flex items-center gap-3 text-[11px]">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: `var(${cssVar})` }}
              />
              <span className="flex-1 text-muted-foreground">{label}</span>
              <span className="font-mono tabular-nums">
                {fmt.n(totals.tokens[key])}
              </span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border/50 pt-1 text-[11px]">
            <span>{totals.count} dispatch{totals.count === 1 ? '' : 'es'}</span>
            <span className="font-mono">{fmt.n(total)} tok</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

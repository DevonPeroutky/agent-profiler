import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn, formatDuration } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { SpanNode } from '@/types';

export interface FlatRow {
  span: SpanNode;
  depth: number;
  hasChildren: boolean;
}

export function flattenSpanTree(
  node: SpanNode,
  depth: number,
  collapsed: Set<string>,
  out: FlatRow[],
) {
  out.push({ span: node, depth, hasChildren: node.children.length > 0 });
  if (collapsed.has(node.spanId)) return;
  for (const c of node.children) flattenSpanTree(c, depth + 1, collapsed, out);
}

interface SpanDescription {
  color: string;
  label: string;
  emphasisClass?: string;
}

type TooltipData =
  | { kind: 'kv'; label: string; raw: string }
  | { kind: 'text'; label: string; value: string };

const TOOLTIP_ATTRS: ReadonlyArray<
  readonly [string, string, TooltipData['kind']]
> = [
  ['agent_trace.tool.input_summary', 'Tool Input', 'kv'],
  ['agent_trace.subagent.task', 'Subagent Task', 'text'],
  ['agent_trace.skill.name', 'Skill', 'text'],
  ['agent_trace.hook.command', 'Hook Command', 'text'],
] as const;

function getTooltipContent(span: SpanNode): TooltipData | null {
  for (const [key, label, kind] of TOOLTIP_ATTRS) {
    const v = span.attributes[key];
    if (v == null || v === '') continue;
    const s = String(v);
    return kind === 'kv'
      ? { kind, label, raw: s }
      : { kind, label, value: s };
  }
  return null;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function parseKeyValues(raw: string): Array<[string, string]> | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return Object.entries(parsed).map(([k, v]) => [k, formatValue(v)]);
    }
  } catch {
    // fall through
  }
  return null;
}

function formatKindLabel(
  kind: string,
  specifier: unknown,
  fallback?: string,
): string {
  if (typeof specifier === 'string' && specifier) return `${kind}: ${specifier}`;
  if (fallback) return `${kind}: ${fallback}`;
  return kind;
}

const LABEL_MAX = 50;

const TOOL_LABEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Bash:  ['command'],
  Read:  ['file_path'],
  Edit:  ['file_path'],
  Write: ['file_path'],
  Glob:  ['pattern'],
  Grep:  ['pattern'],
  Agent: ['subagent_type', 'description'],
  Task:  ['subagent_type', 'description'],
};

function truncateLabel(value: string): string {
  return value.length <= LABEL_MAX ? value : value.slice(0, LABEL_MAX - 1) + '…';
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function toolDetail(toolName: string, inputSummary: unknown): string | null {
  const fields = TOOL_LABEL_FIELDS[toolName];
  if (!fields || typeof inputSummary !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputSummary);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of fields) {
    const v = obj[field];
    if (typeof v === 'string' && v.length > 0) {
      return field === 'file_path' ? basename(v) : v;
    }
  }
  return null;
}

export function describeSpan(span: SpanNode): SpanDescription {
  const { name, attributes } = span;

  if (name.startsWith('turn:')) {
    const model = attributes['gen_ai.request.model'];
    return {
      color: 'bg-[var(--tok-fresh)]',
      label: typeof model === 'string' && model ? `${name} (${model})` : name,
    };
  }
  if (name === 'inference') {
    const model = attributes['gen_ai.request.model'];
    const kind = attributes['agent_trace.inference.kind'];
    const parts: string[] = ['inference'];
    if (typeof kind === 'string' && kind) parts.push(kind);
    if (typeof model === 'string' && model) parts.push(model);
    return {
      color: 'bg-[var(--tok-output)]',
      label: parts.join(' · '),
      emphasisClass: 'text-[var(--tok-output)]',
    };
  }
  if (name.startsWith('subagent:')) {
    const baseLabel = formatKindLabel(
      'subagent',
      attributes['agent_trace.subagent.type'],
      name.slice('subagent:'.length),
    );
    const model = attributes['gen_ai.request.model'];
    return {
      color: 'bg-[var(--tool-subagent)]',
      label: model ? `${baseLabel} (${model})` : baseLabel,
      emphasisClass: 'text-[var(--tool-subagent)]',
    };
  }
  if (name.startsWith('hook:')) {
    return {
      color: 'bg-[var(--tool-read)]',
      label: `hook: ${name.slice('hook:'.length)}`,
      emphasisClass: 'text-[var(--tool-read)]',
    };
  }
  if (name.startsWith('skill:')) {
    return {
      color: 'bg-[var(--tool-write)]',
      label: formatKindLabel(
        'skill',
        attributes['agent_trace.skill.name'],
        name.slice('skill:'.length),
      ),
      emphasisClass: 'text-[var(--tool-write)]',
    };
  }
  if (name.startsWith('task:')) {
    return { color: 'bg-[var(--tok-cache-write)]', label: 'task' };
  }
  if (name === 'compact') {
    return { color: 'bg-[var(--tool-user)]', label: 'compact' };
  }

  const toolName =
    typeof attributes['agent_trace.tool.name'] === 'string' &&
    attributes['agent_trace.tool.name']
      ? (attributes['agent_trace.tool.name'] as string)
      : name;

  if (toolName === 'Skill') {
    const skillName = attributes['agent_trace.skill.name'];
    const slashCommand = attributes['agent_trace.tool.slash_command'];
    const detail =
      (typeof skillName === 'string' && skillName) ||
      (typeof slashCommand === 'string' && slashCommand) ||
      null;
    return {
      color: 'bg-[var(--tool-write)]',
      label: detail ? `Skill(${truncateLabel(detail)})` : 'Skill',
    };
  }

  const detail = toolDetail(toolName, attributes['agent_trace.tool.input_summary']);
  const label = detail ? `${toolName}(${truncateLabel(detail)})` : name;
  return { color: 'bg-[var(--tok-cache-read)]', label };
}

export const LEGEND_ITEMS: ReadonlyArray<{ label: string; cls: string }> = [
  { label: 'Turn',      cls: 'bg-[var(--tok-fresh)]' },
  { label: 'Inference', cls: 'bg-[var(--tok-output)]' },
  { label: 'Subagent',  cls: 'bg-[var(--tool-subagent)]' },
  { label: 'Skill',     cls: 'bg-[var(--tool-write)]' },
  { label: 'Hook',      cls: 'bg-[var(--tool-read)]' },
  { label: 'Tool',      cls: 'bg-[var(--tok-cache-read)]' },
] as const;

export interface SpanRowProps {
  span: SpanNode;
  depth: number;
  hasChildren: boolean;
  isSelected: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onSelect: () => void;
  bar: ReactNode;
  labelLeftPct: number;
  labelSuffix?: ReactNode;
}

export function SpanRow({
  span,
  depth,
  hasChildren,
  isSelected,
  isCollapsed,
  onToggle,
  onSelect,
  bar,
  labelLeftPct,
  labelSuffix,
}: SpanRowProps) {
  const hasError = span.status?.code === 2;
  const { label, emphasisClass } = describeSpan(span);
  const textClass = hasError
    ? 'text-destructive'
    : emphasisClass && cn('font-semibold', emphasisClass);

  const row = (
    <div
      className={cn(
        'group flex min-w-max cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-accent/40',
        isSelected && 'bg-accent/60',
      )}
      onClick={onSelect}
    >
      <div
        className="flex shrink-0 items-center"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-200 ease-out',
                isCollapsed && '-rotate-90',
              )}
            />
          </button>
        ) : (
          <span className="inline-block w-3" />
        )}
      </div>
      <span className="w-14 shrink-0 text-left text-[10px] text-muted-foreground tabular-nums">
        {formatDuration(span.durationMs)}
      </span>
      <div className="relative h-3 w-[400px] shrink-0">
        {bar}
        <span
          className={cn(
            'absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-2 text-[11px]',
            textClass || 'text-foreground',
          )}
          style={{ left: `${labelLeftPct}%` }}
        >
          {label}
          {labelSuffix}
        </span>
      </div>
    </div>
  );

  const tip = getTooltipContent(span);
  if (!tip) return row;

  const kvRows = tip.kind === 'kv' ? parseKeyValues(tip.raw) : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-sm max-h-48 overflow-auto"
      >
        <div className="text-[10px] font-semibold uppercase text-muted-foreground">
          {tip.label}
        </div>
        {kvRows ? (
          <dl className="mt-1 space-y-1.5">
            {kvRows.map(([k, v]) => (
              <div key={k}>
                <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {k}
                </dt>
                <dd className="whitespace-pre-wrap break-all font-mono text-[11px]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px]">
            {tip.kind === 'kv' ? tip.raw : tip.value}
          </pre>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

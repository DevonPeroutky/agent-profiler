import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts';
import type { ConversationSummary, SpanNode } from '@/types';
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ui/chart';
import { SectionCard } from '@/components/ui/section-card';
import { ChartTooltipShell } from '@/components/ui/chart-tooltip-shell';
import { cn } from '@/lib/utils';
import { fmt } from './format';
import {
  MAIN_OWNER,
  createOwnerRegistry,
  extractSkillName,
  finalizeOwnerLabels,
  flattenOwnedSpans,
  type FlatOwnedSpan,
  type OwnerInfo,
  type OwnerRegistry,
} from './ownerRegistry';

type Metric = 'count' | 'bytes';

interface OwnerSlice {
  ownerKey: string;
  ownerLabel: string;
  ownerColor: string;
  ownerKind: OwnerInfo['kind'];
  count: number;
  bytes: number;
}

interface ToolRow {
  key: string;
  displayLabel: string;
  toolName: string;
  subKey: string | null;
  count: number;
  bytes: number;
  meanBytes: number;
  maxBytes: number;
  owners: OwnerSlice[];
  // Recharts needs flat numeric fields per stack series; populated dynamically:
  // [`count_${ownerKey}`]: number, [`bytes_${ownerKey}`]: number
  [stackKey: string]: number | string | null | OwnerSlice[];
}

interface GroupKey {
  key: string;
  displayLabel: string;
  toolName: string;
  subKey: string | null;
}

const ROW_HEIGHT_PX = 32;
const MIN_CHART_HEIGHT_PX = 240;
const MAX_TOP_ROWS = 9;
const OTHER_ROW_KEY = '__other__';

function parseBashCommand(inputSummary: string | undefined): string | null {
  if (!inputSummary) return null;
  try {
    const parsed = JSON.parse(inputSummary) as { command?: unknown };
    if (typeof parsed.command === 'string' && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // truncated or non-JSON input — fall through
  }
  return null;
}

// Verbs whose second token is a meaningful identifier — either a real
// subcommand (`git diff`, `npm run`) or a script the runner is executing
// (`python3 ../gh.py`). For every other command, the second token is just a
// flag or argument and should not split the bucket: `grep -n` and `grep -B1`
// must land in the same row.
const MULTIPLEXER_VERBS = new Set([
  // subcommand-style
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'cargo', 'kubectl', 'docker', 'make',
  'bundle', 'pip', 'pip3', 'brew', 'helm', 'rustup',
  // script-runner-style (second token is the script path or `-c` / `-m`)
  'python', 'python3', 'node', 'bun', 'deno', 'ruby', 'bash', 'sh',
]);

// Strip leading `sudo` and any `KEY=VAL ` env assignments, then return the
// command verb and — for multiplexer verbs only — the next meaningful token.
function bashVerbAndSub(command: string): { verb: string; sub: string | null } {
  const tokens = command.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'sudo') {
      i += 1;
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/i.test(t)) {
      i += 1;
      continue;
    }
    break;
  }
  const verb = tokens[i] ?? '';
  if (!verb || !MULTIPLEXER_VERBS.has(verb)) return { verb, sub: null };
  const sub = tokens[i + 1] ?? null;
  return { verb, sub };
}

// If `s` looks like a filesystem path (contains a slash, possibly wrapped in
// quotes), collapse it to `../<basename>` so two invocations that differ only
// in the directory part of a path land in the same bucket. Otherwise return
// `s` as-is.
function collapsePathLike(s: string): string {
  const unquoted = s.replace(/^['"]+|['"]+$/g, '');
  if (!unquoted.includes('/')) return s;
  const trimmed = unquoted.replace(/\/+$/, '');
  const basename = trimmed.split('/').pop() ?? trimmed;
  if (!basename) return s;
  return `../${basename}`;
}

const MAX_LABEL_CHARS = 28;

function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// MCP tool names look like:
//   mcp__plugin_playwright_playwright__browser_click
//   mcp__claude_ai_Notion__notion-search
//   mcp__<server>__<tool>
// Split on `__` and treat the segment(s) between the leading `mcp` and the
// trailing tool name as the server identifier. We collapse all per-server
// tool calls into a single row.
function mcpServerKey(toolName: string): { key: string; label: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length < 3) return null;
  const rawServer = parts.slice(1, -1).join('__');

  const tokens = rawServer
    .replace(/^plugin_/, '')
    .replace(/^claude_ai_/, '')
    .split('_')
    .filter(Boolean);
  // Plugin servers often repeat the plugin name as the server name, producing
  // `plugin_playwright_playwright` → tokens [playwright, playwright]. Collapse
  // consecutive duplicates so the label reads cleanly.
  const deduped: string[] = [];
  for (const t of tokens) {
    if (deduped[deduped.length - 1]?.toLowerCase() !== t.toLowerCase()) {
      deduped.push(t);
    }
  }
  const pretty = deduped.join(' ').trim();
  const label = `${pretty || rawServer} (mcp)`;
  return { key: `mcp:${rawServer}`, label };
}

function groupKeyForSpan(span: SpanNode): GroupKey {
  const attrs = span.attributes;
  const tool =
    typeof attrs['agent_trace.tool.name'] === 'string'
      ? (attrs['agent_trace.tool.name'] as string)
      : span.name;

  if (tool === 'Bash') {
    const command = parseBashCommand(
      typeof attrs['agent_trace.tool.input_summary'] === 'string'
        ? (attrs['agent_trace.tool.input_summary'] as string)
        : undefined,
    );
    if (command) {
      const { verb, sub } = bashVerbAndSub(command);
      if (verb) {
        const collapsedSub = sub ? collapsePathLike(sub) : null;
        const subKey = collapsedSub ? `${verb} ${collapsedSub}` : verb;
        const rawLabel = `Bash: ${subKey}`;
        return {
          key: rawLabel,
          displayLabel: ellipsize(rawLabel, MAX_LABEL_CHARS),
          toolName: 'Bash',
          subKey,
        };
      }
    }
    return { key: 'Bash', displayLabel: 'Bash', toolName: 'Bash', subKey: null };
  }

  if (tool === 'Skill') {
    const skill = extractSkillName(span);
    if (skill) {
      const rawLabel = `Skill: ${skill}`;
      return {
        key: rawLabel,
        displayLabel: ellipsize(rawLabel, MAX_LABEL_CHARS),
        toolName: 'Skill',
        subKey: skill,
      };
    }
    return { key: 'Skill', displayLabel: 'Skill', toolName: 'Skill', subKey: null };
  }

  const mcp = mcpServerKey(tool);
  if (mcp) {
    return {
      key: mcp.key,
      displayLabel: ellipsize(mcp.label, MAX_LABEL_CHARS),
      toolName: tool,
      subKey: null,
    };
  }

  return {
    key: tool,
    displayLabel: ellipsize(tool, MAX_LABEL_CHARS),
    toolName: tool,
    subKey: null,
  };
}

// A tool span is anything we want to surface as a user-facing tool call.
// Mirrors `isStructuralSpan` from `transforms.ts` but stays inline here so
// the rule is easy to spot: skip inferences and any span that is a
// structural wrapper (subagent root, unattached-group root, etc.).
function isToolSpan(span: SpanNode): boolean {
  if (span.name === 'inference') return false;
  if (span.attributes['agent_trace.event_type']) return false;
  return true;
}

function buildRows(
  conversation: ConversationSummary,
  metric: Metric,
): { rows: ToolRow[]; owners: OwnerInfo[] } {
  const registry: OwnerRegistry = createOwnerRegistry();
  const ownersSeen: OwnerInfo[] = [MAIN_OWNER];
  const all: FlatOwnedSpan[] = [];

  for (const turn of conversation.turns) {
    for (const f of flattenOwnedSpans(
      turn.root,
      turn.turnNumber,
      registry,
      ownersSeen,
    )) {
      all.push(f);
    }
  }
  for (const group of conversation.unattached) {
    for (const f of flattenOwnedSpans(group.root, null, registry, ownersSeen)) {
      all.push(f);
    }
  }

  finalizeOwnerLabels(ownersSeen);

  type Bucket = {
    key: string;
    displayLabel: string;
    toolName: string;
    subKey: string | null;
    count: number;
    bytes: number;
    maxBytes: number;
    bytesSamples: number[];
    byOwner: Map<string, OwnerSlice>;
  };

  const buckets = new Map<string, Bucket>();
  const usedOwnerKeys = new Set<string>();

  for (const f of all) {
    if (!isToolSpan(f.node)) continue;
    const gk = groupKeyForSpan(f.node);
    const bytesAttr = f.node.attributes['agent_trace.tool.output_bytes'];
    const bytes =
      typeof bytesAttr === 'number' && Number.isFinite(bytesAttr)
        ? bytesAttr
        : 0;

    let bucket = buckets.get(gk.key);
    if (!bucket) {
      bucket = {
        key: gk.key,
        displayLabel: gk.displayLabel,
        toolName: gk.toolName,
        subKey: gk.subKey,
        count: 0,
        bytes: 0,
        maxBytes: 0,
        bytesSamples: [],
        byOwner: new Map(),
      };
      buckets.set(gk.key, bucket);
    }
    bucket.count += 1;
    bucket.bytes += bytes;
    bucket.bytesSamples.push(bytes);
    if (bytes > bucket.maxBytes) bucket.maxBytes = bytes;

    let slice = bucket.byOwner.get(f.owner.key);
    if (!slice) {
      slice = {
        ownerKey: f.owner.key,
        ownerLabel: f.owner.label,
        ownerColor: f.owner.color,
        ownerKind: f.owner.kind,
        count: 0,
        bytes: 0,
      };
      bucket.byOwner.set(f.owner.key, slice);
    }
    slice.count += 1;
    slice.bytes += bytes;
    usedOwnerKeys.add(f.owner.key);
  }

  const rows: ToolRow[] = [];
  for (const bucket of buckets.values()) {
    const meanBytes = bucket.count === 0 ? 0 : bucket.bytes / bucket.count;
    const owners = Array.from(bucket.byOwner.values()).sort(
      (a, b) => sliceMetric(b, metric) - sliceMetric(a, metric),
    );
    const row: ToolRow = {
      key: bucket.key,
      displayLabel: bucket.displayLabel,
      toolName: bucket.toolName,
      subKey: bucket.subKey,
      count: bucket.count,
      bytes: bucket.bytes,
      meanBytes,
      maxBytes: bucket.maxBytes,
      owners,
    };
    for (const slice of owners) {
      row[`count_${slice.ownerKey}`] = slice.count;
      row[`bytes_${slice.ownerKey}`] = slice.bytes;
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    const primary = rowMetric(b, metric) - rowMetric(a, metric);
    if (primary !== 0) return primary;
    return rowMetric(b, otherMetric(metric)) - rowMetric(a, otherMetric(metric));
  });

  const trimmed = collapseTail(rows, metric);
  const visibleOwners = ownersSeen.filter((o) => usedOwnerKeys.has(o.key));
  return { rows: trimmed, owners: visibleOwners };
}

// Keep the top `MAX_TOP_ROWS` rows by the active metric and roll everything
// else into a single "Other" row (its owner stack is the sum of the tail's
// owner stacks, so the bar still segments by who issued the calls).
function collapseTail(rows: ToolRow[], metric: Metric): ToolRow[] {
  if (rows.length <= MAX_TOP_ROWS + 1) return rows;
  const top = rows.slice(0, MAX_TOP_ROWS);
  const tail = rows.slice(MAX_TOP_ROWS);

  const ownerTotals = new Map<string, OwnerSlice>();
  let count = 0;
  let bytes = 0;
  let maxBytes = 0;
  for (const r of tail) {
    count += r.count;
    bytes += r.bytes;
    if (r.maxBytes > maxBytes) maxBytes = r.maxBytes;
    for (const slice of r.owners) {
      const existing = ownerTotals.get(slice.ownerKey);
      if (existing) {
        existing.count += slice.count;
        existing.bytes += slice.bytes;
      } else {
        ownerTotals.set(slice.ownerKey, { ...slice });
      }
    }
  }
  const owners = Array.from(ownerTotals.values()).sort(
    (a, b) => sliceMetric(b, metric) - sliceMetric(a, metric),
  );
  const label = `Other (${tail.length})`;
  const otherRow: ToolRow = {
    key: OTHER_ROW_KEY,
    displayLabel: label,
    toolName: label,
    subKey: null,
    count,
    bytes,
    meanBytes: count === 0 ? 0 : bytes / count,
    maxBytes,
    owners,
  };
  for (const slice of owners) {
    otherRow[`count_${slice.ownerKey}`] = slice.count;
    otherRow[`bytes_${slice.ownerKey}`] = slice.bytes;
  }
  return [...top, otherRow];
}

function rowMetric(r: ToolRow, m: Metric): number {
  return m === 'count' ? r.count : r.bytes;
}

function sliceMetric(s: OwnerSlice, m: Metric): number {
  return m === 'count' ? s.count : s.bytes;
}

function otherMetric(m: Metric): Metric {
  return m === 'count' ? 'bytes' : 'count';
}

function buildChartConfig(owners: OwnerInfo[]): ChartConfig {
  const config: ChartConfig = {};
  for (const o of owners) {
    config[o.key] = { label: o.label, color: o.color };
  }
  return config;
}

interface Props {
  conversation: ConversationSummary;
}

export function ToolUsageOverviewChart({ conversation }: Props) {
  const [metric, setMetric] = useState<Metric>('bytes');
  const { rows, owners } = useMemo(
    () => buildRows(conversation, metric),
    [conversation, metric],
  );
  const chartConfig = useMemo(() => buildChartConfig(owners), [owners]);

  if (conversation.turns.length === 0 && conversation.unattached.length === 0) {
    return null;
  }

  const chartHeight = Math.max(MIN_CHART_HEIGHT_PX, rows.length * ROW_HEIGHT_PX + 24);
  const stackKeyPrefix = metric === 'count' ? 'count_' : 'bytes_';

  return (
    <SectionCard
      title="Tool calls"
      meta={<MetricToggle metric={metric} onChange={setMetric} />}
      bodyClassName="p-0"
    >
      {rows.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          No tool calls in this conversation.
        </div>
      ) : (
        <div className="max-h-[36rem] overflow-y-auto px-3 pt-3 pb-2">
          <ChartContainer
            config={chartConfig}
            className="w-full"
            style={{ height: chartHeight, aspectRatio: 'auto' }}
          >
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
              barCategoryGap={4}
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                tickFormatter={(v: number) =>
                  metric === 'bytes' ? fmt.bytes(v) : fmt.n(v)
                }
              />
              <YAxis
                type="category"
                dataKey="displayLabel"
                tickLine={false}
                axisLine={false}
                width={140}
                interval={0}
                tick={{ fontSize: 11 }}
              />
              <ChartTooltip
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                content={<ToolTooltip metric={metric} />}
              />
              {owners.map((o, i) => {
                const dataKey = `${stackKeyPrefix}${o.key}`;
                const isLast = i === owners.length - 1;
                return (
                  <Bar
                    key={o.key}
                    dataKey={dataKey}
                    name={o.label}
                    stackId="owner"
                    fill={o.color}
                    radius={isLast ? [0, 3, 3, 0] : 0}
                    isAnimationActive={false}
                  />
                );
              })}
            </BarChart>
          </ChartContainer>
          {owners.length > 0 ? <OwnerLegend owners={owners} /> : null}
        </div>
      )}
    </SectionCard>
  );
}

function MetricToggle({
  metric,
  onChange,
}: {
  metric: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border text-[11px]">
      <button
        type="button"
        onClick={() => onChange('count')}
        className={cn(
          'px-2 py-0.5 font-medium transition-colors',
          metric === 'count'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        Count
      </button>
      <button
        type="button"
        onClick={() => onChange('bytes')}
        className={cn(
          'px-2 py-0.5 font-medium transition-colors border-l border-border',
          metric === 'bytes'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        Bytes
      </button>
    </div>
  );
}

function OwnerLegend({ owners }: { owners: OwnerInfo[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px]">
      {owners.map((o) => (
        <div key={o.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={{ background: o.color }}
          />
          <span className="min-w-0 truncate text-muted-foreground">
            {o.label}
          </span>
        </div>
      ))}
    </div>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ToolRow }>;
}

function ToolTooltip({
  metric,
  active,
  payload,
}: TooltipProps & { metric: Metric }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <ChartTooltipShell>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{row.displayLabel}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
          {metric}
        </span>
      </div>
      {row.toolName !== row.displayLabel ? (
        <div className="-mt-1 font-mono text-[10px] text-muted-foreground/80">
          {row.toolName}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 border-t border-border/50 pt-2 font-mono text-[11px]">
        <span className="text-muted-foreground">Calls</span>
        <span className="text-right tabular-nums">{fmt.n(row.count)}</span>
        <span className="text-muted-foreground">Total bytes</span>
        <span className="text-right tabular-nums">{fmt.bytes(row.bytes)}</span>
        <span className="text-muted-foreground">Mean / call</span>
        <span className="text-right tabular-nums">
          {fmt.bytes(Math.round(row.meanBytes))}
        </span>
        <span className="text-muted-foreground">Max / call</span>
        <span className="text-right tabular-nums">{fmt.bytes(row.maxBytes)}</span>
      </div>

      {row.owners.length > 1 ? (
        <div>
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
            By owner
          </div>
          <ul className="flex flex-col gap-0.5">
            {row.owners.map((o) => (
              <li
                key={o.ownerKey}
                className="flex min-w-0 items-center gap-2 text-[11px]"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: o.ownerColor }}
                />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {o.ownerLabel}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                  {fmt.n(o.count)} · {fmt.bytes(o.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ChartTooltipShell>
  );
}

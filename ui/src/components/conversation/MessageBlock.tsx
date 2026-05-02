import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmt } from './format';
import type { InferenceUsage } from './transforms';

interface Props {
  text: string;
  usage?: InferenceUsage;
}

const TOK_ROWS: Array<{
  key: keyof InferenceUsage;
  label: string;
  cssVar: string;
}> = [
  { key: 'inputTokens', label: 'Fresh input', cssVar: '--tok-fresh' },
  { key: 'cacheReadTokens', label: 'Cache read', cssVar: '--tok-cache-read' },
  {
    key: 'cacheCreationTokens',
    label: 'Cache write',
    cssVar: '--tok-cache-write',
  },
  { key: 'outputTokens', label: 'Output', cssVar: '--tok-output' },
];

export function MessageBlock({ text, usage }: Props) {
  const hasUsage =
    !!usage &&
    (usage.inputTokens > 0 ||
      usage.cacheReadTokens > 0 ||
      usage.cacheCreationTokens > 0 ||
      usage.outputTokens > 0);

  const inputTotal = usage
    ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
    : 0;

  return (
    <div className="px-4 py-2">
      <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
        {text}
      </pre>
      {hasUsage && usage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="mt-1 flex cursor-default justify-end font-mono text-[10px] text-muted-foreground/60 hover:text-muted-foreground">
              {fmt.n(inputTotal)} in · {fmt.n(usage.outputTokens)} out
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="px-3 py-2">
            <div className="flex flex-col gap-1">
              {TOK_ROWS.map(({ key, label, cssVar }) => (
                <div key={key} className="flex items-center gap-3 text-[11px]">
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: `var(${cssVar})` }}
                  />
                  <span className="flex-1 text-muted-foreground">{label}</span>
                  <span className="font-mono tabular-nums">{fmt.n(usage[key])}</span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

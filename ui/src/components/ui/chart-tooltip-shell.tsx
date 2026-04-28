import * as React from 'react';
import { cn } from '@/lib/utils';

interface ChartTooltipShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function ChartTooltipShell({
  children,
  className,
  ...rest
}: ChartTooltipShellProps) {
  return (
    <div
      className={cn(
        'grid w-[28rem] max-w-[calc(100vw-3rem)] grid-cols-1 gap-2 overflow-hidden rounded-lg border border-border/50 bg-background px-3 py-2.5 text-xs shadow-xl [&>*]:min-w-0',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

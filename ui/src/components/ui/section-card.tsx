import * as React from 'react';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  title: string;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
}

export function SectionCard({
  title,
  meta,
  footer,
  bodyClassName,
  children,
}: SectionCardProps) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="text-balance text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {title}
        </h2>
        {meta != null ? (
          <span className="text-xs text-muted-foreground/70">{meta}</span>
        ) : null}
      </div>
      <div className={cn('p-3', bodyClassName)}>{children}</div>
      {footer != null ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground/70">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

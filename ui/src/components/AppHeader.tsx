import { Activity, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/ThemeToggle';
import { formatRelativeTime } from '@/lib/utils';

interface Props {
  conversationCount: number;
  traceCount: number;
  lastFetched: number | null;
  loading: boolean;
  onRefresh: () => void;
  showMeta: boolean;
  onToggleMeta: (next: boolean) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function AppHeader({
  conversationCount,
  traceCount,
  lastFetched,
  loading,
  onRefresh,
  showMeta,
  onToggleMeta,
  sidebarCollapsed,
  onToggleSidebar,
}: Props) {
  const sidebarLabel = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <header className="flex items-center justify-between border-b border-border px-6 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onToggleSidebar}
                aria-label={sidebarLabel}
                className="h-8 w-8 shrink-0"
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {sidebarLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Activity className="h-5 w-5 shrink-0 text-emerald-400" />
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-sm font-semibold shrink-0">agent-trace explorer</h1>
          <span className="truncate text-xs text-muted-foreground">
            {conversationCount} conversation
            {conversationCount === 1 ? '' : 's'} · {traceCount} trace
            {traceCount === 1 ? '' : 's'}
            {lastFetched ? ` · refreshed ${formatRelativeTime(lastFetched)}` : ''}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={showMeta}
            onCheckedChange={onToggleMeta}
            aria-label="Show meta turns"
            className="data-[state=unchecked]:bg-muted-foreground/30"
          />
          Show meta
        </label>
        <ThemeToggle />
      </div>
    </header>
  );
}

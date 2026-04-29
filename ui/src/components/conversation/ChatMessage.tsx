import { ReactNode } from 'react';
import { ChevronDown, User } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import { cn, formatRelativeTime, formatTokens } from '@/lib/utils';
import type { TurnOutcome } from './transforms';

interface Props {
  body: string;
  bodyMuted?: boolean;
  omitUserRow?: boolean;
  isOpen: boolean;
  onToggle: () => void;
  startMs: number;
  isRunning?: boolean;
  toolCount: number;
  models?: string[];
  contextTokens?: number;
  attachmentCount: number;
  attachmentBytes: number;
  finalMode?: string | null;
  extraBadges?: ReactNode;
  outcome?: TurnOutcome;
  assistantAvatarRef?: React.Ref<HTMLSpanElement>;
  children: ReactNode;
}

interface RowProps {
  avatar: ReactNode;
  avatarRef?: React.Ref<HTMLSpanElement>;
  avatarBare?: boolean;
  title: string;
  body?: ReactNode;
  badges?: ReactNode;
}

function Row({ avatar, avatarRef, avatarBare, title, body, badges }: RowProps) {
  return (
    <div className="flex items-start gap-3 py-3 pl-6 pr-6">
      {avatarBare ? (
        <span
          ref={avatarRef}
          className="relative z-20 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background"
        >
          {avatar}
        </span>
      ) : (
        <Avatar
          ref={avatarRef}
          className="relative z-20 h-6 w-6 bg-background"
        >
          <AvatarFallback className="bg-muted text-muted-foreground">
            {avatar}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground/80">
            {title}
          </span>
        </div>
        {body !== undefined && body !== null && (
          <div className="mt-1 text-[15px] leading-relaxed">{body}</div>
        )}
        {badges && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {badges}
          </div>
        )}
      </div>
    </div>
  );
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

function outcomeContent(outcome: TurnOutcome): ReactNode {
  switch (outcome.kind) {
    case 'completed':
      return outcome.text;
    case 'truncated':
      return outcome.text;
    case 'running':
      return null;
    case 'silent':
      return null;
    case 'paused':
      return <span className="italic text-muted-foreground">(paused)</span>;
    case 'refused':
      return <span className="italic text-muted-foreground">(refused)</span>;
  }
}

export function ChatMessage({
  body,
  bodyMuted,
  omitUserRow,
  isOpen,
  onToggle,
  startMs,
  isRunning,
  toolCount,
  models,
  contextTokens,
  attachmentCount,
  attachmentBytes,
  finalMode,
  extraBadges,
  outcome,
  assistantAvatarRef,
  children,
}: Props) {
  const showMode = finalMode && finalMode !== 'default';
  const showTokens = typeof contextTokens === 'number' && contextTokens > 0;
  const showAttachments = attachmentCount > 0;
  const bookend = outcome ? outcomeContent(outcome) : null;
  const hasActivity =
    Boolean(isRunning) ||
    toolCount > 0 ||
    showTokens ||
    showAttachments ||
    Boolean(showMode) ||
    Boolean(models && models.length > 0);
  const activityBadges = hasActivity ? (
    <>
      {isRunning && (
        <Badge
          variant="default"
          className="animate-pulse bg-emerald-600 text-[10px]"
        >
          running
        </Badge>
      )}
      {toolCount > 0 && (
        <Badge variant="outline" className="text-[10px]">
          {toolCount} call{toolCount === 1 ? '' : 's'}
        </Badge>
      )}
      {showTokens && (
        <Badge variant="outline" className="font-mono text-[10px]">
          {formatTokens(contextTokens!)} ctx
        </Badge>
      )}
      {showAttachments && (
        <Badge
          variant="outline"
          className="font-mono text-[10px] text-muted-foreground"
        >
          {attachmentCount} att ·{' '}
          {attachmentBytes < 1024
            ? `${attachmentBytes}B`
            : `${Math.round(attachmentBytes / 1024)}KB`}
        </Badge>
      )}
      {showMode && (
        <Badge variant="secondary" className="text-[10px]">
          {finalMode}
        </Badge>
      )}
      {models?.map((m) => (
        <Badge key={m} variant="outline" className="font-mono text-[10px]">
          {m}
        </Badge>
      ))}
    </>
  ) : null;

  const assistantBadges = (
    <>
      {activityBadges}
      <span className="text-[10px] text-muted-foreground">
        {formatRelativeTime(startMs)}
      </span>
      <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {isOpen ? 'hide trace' : 'view trace'}
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-200 ease-out',
            !isOpen && '-rotate-90',
          )}
        />
      </span>
    </>
  );

  const userBody = body ? (
    <p
      className={cn(
        'whitespace-pre-wrap text-pretty',
        bodyMuted ? 'italic text-muted-foreground' : 'text-foreground',
      )}
    >
      {body}
    </p>
  ) : (
    <p className="italic text-muted-foreground">(no prompt)</p>
  );

  const assistantBody = omitUserRow
    ? body
      ? (
          <p
            className={cn(
              'whitespace-pre-wrap',
              bodyMuted ? 'italic text-muted-foreground' : 'text-foreground',
            )}
          >
            {body}
          </p>
        )
      : null
    : bookend
      ? <p className="whitespace-pre-wrap text-foreground">{bookend}</p>
      : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={isOpen}
      className={cn(
        'group w-full cursor-pointer text-left transition-colors hover:bg-accent/20',
        'focus:outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-inset',
        isOpen && 'bg-accent/10',
      )}
    >
      {!omitUserRow && (
        <Row
          avatar={userAvatarIcon}
          title="You"
          body={userBody}
          badges={extraBadges}
        />
      )}
      <Row
        avatar={claudeAvatarIcon}
        avatarRef={assistantAvatarRef}
        avatarBare
        title="Claude"
        body={assistantBody}
        badges={assistantBadges}
      />
      <Collapsible open={isOpen}>
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up">
          <div
            onClick={(e) => e.stopPropagation()}
            className="my-3 mr-6 cursor-auto rounded-md border border-border/60 bg-muted/20 ml-[calc(1.5rem+24px+0.75rem)]"
          >
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

import { ConversationDetail } from '@/components/ConversationDetail';
import { ConversationList } from '@/components/ConversationList';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { useTraces } from '@/hooks/useTraces';
import { useSidebarCollapsed } from '@/lib/sidebar';
import { cn } from '@/lib/utils';
import type { ConversationSummary, SpanNode, TraceSummary, Turn, UnattachedGroup } from '@/types';
import { ArrowRight, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

const INTEREST_FORM_ID = 'mojryawb';
const INTEREST_FORM_ENDPOINT = `https://formspree.io/f/${INTEREST_FORM_ID}`;

const INTEREST_OPTIONS = [
  { value: 'otel-export', label: 'Export traces to an OTEL provider' },
  { value: 'team-usage', label: 'Track usage across my engineering team' },
  { value: 'both', label: 'Both' },
  { value: 'other', label: 'Other' },
] as const;

type InterestSubmitState = 'idle' | 'submitting' | 'success' | 'error';

type FormspreeErrorResponse = {
  error?: string;
  errors?: Array<{ field?: string; message?: string }>;
};

function formspreeErrorMessage(body: FormspreeErrorResponse | null): string {
  if (!body) return 'Unable to submit interest.';
  if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  const messages = body.errors
    ?.map((err) => {
      if (!err.message) return null;
      return err.field ? `${err.field}: ${err.message}` : err.message;
    })
    .filter((message): message is string => Boolean(message));
  return messages && messages.length > 0 ? messages.join(' ') : 'Unable to submit interest.';
}

function groupConversations(traces: TraceSummary[]): ConversationSummary[] {
  const bySession = new Map<string, TraceSummary[]>();
  for (const t of traces) {
    const list = bySession.get(t.sessionId);
    if (list) list.push(t);
    else bySession.set(t.sessionId, [t]);
  }

  const conversations: ConversationSummary[] = [];
  for (const [sessionId, convTraces] of bySession.entries()) {
    const turns: Turn[] = [];
    const unattached: UnattachedGroup[] = [];
    for (const t of convTraces) {
      if (t.kind === 'turn') turns.push(t);
      else unattached.push(t);
    }
    turns.sort((a, b) => a.turnNumber - b.turnNumber);
    unattached.sort((a, b) => a.startMs - b.startMs);

    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    let toolCount = 0;
    let errorCount = 0;
    for (const t of convTraces) {
      if (t.startMs < startMs) startMs = t.startMs;
      if (t.endMs > endMs) endMs = t.endMs;
      toolCount += t.toolCount;
      errorCount += t.errorCount;
    }

    conversations.push({
      sessionId,
      turns,
      unattached,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      turnCount: turns.length,
      toolCount,
      errorCount,
      isRunning: turns.some((t) => t.isRunning) || unattached.some((u) => u.isRunning),
      cwd: convTraces.find((t) => t.cwd)?.cwd ?? null,
    });
  }

  conversations.sort((a, b) => b.endMs - a.endMs);
  return conversations;
}

export function App() {
  const { traces, loading, error } = useTraces();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<SpanNode | null>(null);
  const [showBanner, setShowBanner] = useState(true);
  const [showInterestForm, setShowInterestForm] = useState(false);
  const [interestEmail, setInterestEmail] = useState('');
  const [interestKind, setInterestKind] =
    useState<(typeof INTEREST_OPTIONS)[number]['value']>('otel-export');
  const [interestMessage, setInterestMessage] = useState('');
  const [interestSubmitState, setInterestSubmitState] = useState<InterestSubmitState>('idle');
  const [interestSubmitError, setInterestSubmitError] = useState<string | null>(null);
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed();

  const conversations = useMemo(() => groupConversations(traces), [traces]);

  useEffect(() => {
    setSelectedSessionId((prev) => {
      if (prev && conversations.some((c) => c.sessionId === prev)) return prev;
      return conversations[0]?.sessionId ?? null;
    });
  }, [conversations]);

  const selected = useMemo(
    () => conversations.find((c) => c.sessionId === selectedSessionId) ?? null,
    [conversations, selectedSessionId],
  );

  useEffect(() => {
    setSelectedSpan(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (selected) console.debug('[agent-trace]', selected);
  }, [selected]);

  useEffect(() => {
    if (!showInterestForm) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowInterestForm(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showInterestForm]);

  async function submitInterest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInterestSubmitState('submitting');
    setInterestSubmitError(null);

    try {
      const interestLabel =
        INTEREST_OPTIONS.find((option) => option.value === interestKind)?.label ?? interestKind;
      const formData = new FormData(event.currentTarget);
      formData.set('interest', interestLabel);
      formData.set('_subject', `agent-profiler interest: ${interestLabel}`);
      formData.set('source', 'agent-profiler');
      formData.set('submittedAt', new Date().toISOString());

      const response = await fetch(INTEREST_FORM_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
        },
        body: formData,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as FormspreeErrorResponse | null;
        throw new Error(formspreeErrorMessage(body));
      }

      setInterestSubmitState('success');
      setInterestEmail('');
      setInterestKind('otel-export');
      setInterestMessage('');
    } catch (err) {
      setInterestSubmitState('error');
      setInterestSubmitError(err instanceof Error ? err.message : 'Unable to submit interest.');
    }
  }

  return (
    <div className="flex h-screen flex-col">
      {showBanner && (
        <div className="relative flex shrink-0 flex-col gap-2 border-b border-border bg-secondary/70 py-2 pl-4 pr-12 text-secondary-foreground sm:flex-row sm:items-center sm:justify-center sm:px-6 sm:pr-12">
          <p className="text-sm font-medium">
            Want to export these traces to an OTEL provider or track usage across your engineering
            team?
          </p>
          <Button
            type="button"
            onClick={() => {
              setInterestSubmitState('idle');
              setInterestSubmitError(null);
              setShowInterestForm(true);
            }}
            className="h-8 px-3 text-xs"
          >
            Reach out
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setShowBanner(false)}
            aria-label="Dismiss banner"
            title="Dismiss banner"
            className="absolute right-2 top-2 h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {showInterestForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm">
          <dialog
            open
            aria-labelledby="interest-form-title"
            className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 id="interest-form-title" className="text-base font-semibold">
                  Register interest
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Tell us what you want to do with your traces.
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                type="button"
                onClick={() => setShowInterestForm(false)}
                aria-label="Close interest form"
                title="Close interest form"
                className="h-8 w-8 shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <form
              action={INTEREST_FORM_ENDPOINT}
              method="POST"
              onSubmit={submitInterest}
              className="space-y-4 px-5 py-4"
            >
              <div className="space-y-1.5">
                <label htmlFor="interest-email" className="text-sm font-medium">
                  Email
                </label>
                <input
                  id="interest-email"
                  name="email"
                  type="email"
                  required
                  value={interestEmail}
                  onChange={(event) => setInterestEmail(event.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="you@example.com"
                  disabled={interestSubmitState === 'submitting'}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="interest-kind" className="text-sm font-medium">
                  Interest
                </label>
                <select
                  id="interest-kind"
                  name="interest"
                  required
                  value={interestKind}
                  onChange={(event) => setInterestKind(event.target.value as typeof interestKind)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={interestSubmitState === 'submitting'}
                >
                  {INTEREST_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="interest-message" className="text-sm font-medium">
                  Notes
                </label>
                <textarea
                  id="interest-message"
                  name="message"
                  value={interestMessage}
                  onChange={(event) => setInterestMessage(event.target.value)}
                  className="flex min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Provider, team size, or anything else useful."
                  disabled={interestSubmitState === 'submitting'}
                />
              </div>
              {interestSubmitState === 'success' && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                  Thanks. We received your interest.
                </div>
              )}
              {interestSubmitState === 'error' && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {interestSubmitError ?? 'Unable to submit interest.'}
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-border pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowInterestForm(false)}
                  disabled={interestSubmitState === 'submitting'}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={interestSubmitState === 'submitting'}>
                  {interestSubmitState === 'submitting' ? 'Submitting...' : 'Submit'}
                </Button>
              </div>
            </form>
          </dialog>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'flex w-80 shrink-0 flex-col border-r border-border',
            sidebarCollapsed && 'hidden',
          )}
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="h-8 w-8"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
            <h1 className="truncate text-sm font-semibold">agent-profiler</h1>
            <ThemeToggle />
          </div>
          <div className="flex-1 overflow-y-auto">
            <ConversationList
              conversations={conversations}
              selectedSessionId={selectedSessionId}
              onSelect={setSelectedSessionId}
            />
          </div>
        </aside>

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {sidebarCollapsed && (
            <Button
              size="icon"
              variant="outline"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="absolute left-2 top-2 z-10 h-8 w-8 bg-background shadow-sm"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
          {error && (
            <div className="border-b border-destructive/50 bg-destructive/10 px-6 py-2 text-xs text-destructive-foreground">
              Failed to load traces: {error}
            </div>
          )}
          <div className={cn('flex flex-1 overflow-hidden', sidebarCollapsed && 'pt-10')}>
            <ConversationDetail
              conversation={selected}
              selectedSpan={selectedSpan}
              onSelectSpan={setSelectedSpan}
              onCloseSpan={() => setSelectedSpan(null)}
              loading={loading}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

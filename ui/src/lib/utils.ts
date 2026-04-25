import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

export function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

const LOCAL_COMMAND_CAVEAT_RE =
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g;

export function stripLocalCommandCaveat(raw: string): string {
  return raw.replace(LOCAL_COMMAND_CAVEAT_RE, '').trim();
}

const COMMAND_TAG_RE = /<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/g;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;

// Claude Code wraps slash-command invocations in a <command-name>/foo</command-name>
// <command-message>…</command-message> <command-args>…</command-args> envelope.
// When the whole prompt is exactly that envelope (nothing else but those tags
// and whitespace), return what the user actually typed — e.g. "/clear". Returns
// null for prompts that aren't pure command envelopes so callers can pass
// through untouched.
export function extractSlashCommand(raw: string): string | null {
  const trimmed = raw.trim();
  const residue = trimmed.replace(COMMAND_TAG_RE, '').trim();
  if (residue.length > 0) return null;
  const match = trimmed.match(COMMAND_NAME_RE);
  return match ? match[1].trim() : null;
}

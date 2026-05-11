// Harness UI registry. Single source of truth for harness-specific display
// metadata (logo, name). Adding a new harness in the data layer? Add a
// matching entry here so the UI renders it with its own avatar + label.
//
// Lives in ui/src/ — separate from lib/adapters/registry.js (which is the
// Node-only data-layer registry). The two registries serve different
// concerns: data adapters can't be imported into the browser bundle.

import type { CSSProperties } from 'react';
import { cn } from './utils';

export interface HarnessMeta {
  /** Display name used in chat row titles, badges, etc. */
  displayName: string;
  /**
   * Path under /public for the harness logo (square asset). Convention:
   * logos must be **tight-cropped** — viewBox (SVG) or raster dimensions
   * should hug the visible geometry. The renderer doesn't compensate for
   * baked-in padding, so an asset with internal whitespace will look
   * undersized next to other logos at the same CSS box size.
   */
  logoSrc: string;
  /**
   * When true, apply `dark:invert` so a black-on-transparent logo (e.g. the
   * OpenAI SVG) becomes visible on dark backgrounds. Leave unset for full-
   * color logos (the Claude PNG, etc.) that already work in both themes.
   */
  invertOnDark?: boolean;
}

/**
 * Known harnesses. Keys MUST match the adapter `id` in
 * `lib/adapters/registry.js` — the UI reads
 * `trace.root.attributes['agent_trace.harness']` and looks up by that key.
 */
const REGISTRY: Record<string, HarnessMeta> = {
  'claude-code': {
    displayName: 'Claude',
    logoSrc: '/images/claude-logo.png',
  },
  codex: {
    displayName: 'Codex',
    logoSrc: '/images/openai-logo.svg',
    invertOnDark: true,
  },
};

/** Used when a harness id isn't in REGISTRY — defensive, shouldn't normally hit. */
const FALLBACK: HarnessMeta = {
  displayName: 'Assistant',
  logoSrc: '/images/claude-logo.png',
};

export function harnessMeta(harness: string | undefined | null): HarnessMeta {
  if (!harness) return FALLBACK;
  return REGISTRY[harness] ?? FALLBACK;
}

interface AvatarProps {
  harness: string | undefined | null;
  className?: string;
  style?: CSSProperties;
}

/**
 * Square logo for the harness. Defaults to 6x6 in Tailwind units; callers can
 * override via className. Decorative by default (aria-hidden) — wrap with a
 * labeled span when the harness identity matters to assistive tech.
 */
export function HarnessAvatar({ harness, className, style }: AvatarProps) {
  const meta = harnessMeta(harness);
  return (
    <img
      src={meta.logoSrc}
      alt=""
      aria-hidden="true"
      className={cn(className ?? 'h-6 w-6 object-contain', meta.invertOnDark && 'dark:invert')}
      style={style}
    />
  );
}

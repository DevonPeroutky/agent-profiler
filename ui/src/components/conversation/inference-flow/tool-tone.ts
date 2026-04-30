import { Folder } from 'lucide-react';
import { createElement, type ReactNode } from 'react';

export interface ToolTone {
  border: string;
  headerBg: string;
  headerText: string;
  badge: string;
  glyph: ReactNode;
}

const FOLDER_GLYPH: ReactNode = createElement(Folder, {
  'aria-hidden': true,
  className: 'h-2.5 w-2.5',
});

export function toolTone(name: string): ToolTone {
  if (name.startsWith('mcp__')) {
    return {
      border: 'border-cyan-500/30',
      headerBg: 'bg-cyan-500/[0.06]',
      headerText: 'text-cyan-500',
      badge: 'bg-cyan-500/15 text-cyan-500',
      glyph: 'M',
    };
  }
  switch (name) {
    case 'Bash':
      return {
        border: 'border-emerald-500/30',
        headerBg: 'bg-emerald-500/[0.06]',
        headerText: 'text-emerald-500',
        badge: 'bg-emerald-500/15 text-emerald-500',
        glyph: '$',
      };
    case 'Read':
      return {
        border: 'border-sky-500/30',
        headerBg: 'bg-sky-500/[0.06]',
        headerText: 'text-sky-500',
        badge: 'bg-sky-500/15 text-sky-500',
        glyph: 'R',
      };
    case 'Write':
      return {
        border: 'border-orange-500/30',
        headerBg: 'bg-orange-500/[0.06]',
        headerText: 'text-orange-500',
        badge: 'bg-orange-500/15 text-orange-500',
        glyph: 'W',
      };
    case 'Edit':
      return {
        border: 'border-orange-500/30',
        headerBg: 'bg-orange-500/[0.06]',
        headerText: 'text-orange-500',
        badge: 'bg-orange-500/15 text-orange-500',
        glyph: 'E',
      };
    case 'Glob':
    case 'Grep':
    case 'ToolSearch':
      return {
        border: 'border-amber-500/30',
        headerBg: 'bg-amber-500/[0.06]',
        headerText: 'text-amber-500',
        badge: 'bg-amber-500/15 text-amber-500',
        glyph: 'S',
      };
    case 'Agent':
    case 'Task':
      return {
        border: 'border-violet-500/30',
        headerBg: 'bg-violet-500/[0.06]',
        headerText: 'text-violet-500',
        badge: 'bg-violet-500/15 text-violet-500',
        glyph: 'A',
      };
    case 'Skill':
      return {
        border: 'border-violet-500/30',
        headerBg: 'bg-violet-500/[0.06]',
        headerText: 'text-violet-500',
        badge: 'bg-violet-500/15 text-violet-500',
        glyph: FOLDER_GLYPH,
      };
    default:
      return {
        border: 'border-border',
        headerBg: 'bg-muted/40',
        headerText: 'text-foreground',
        badge: 'bg-muted text-muted-foreground',
        glyph: '·',
      };
  }
}

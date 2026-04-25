// @ts-check
// Locate Claude Code conversation transcripts on disk and enumerate sessions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

/** @typedef {{
 *   sessionId: string,
 *   projectDir: string,
 *   mainPath: string,
 *   subagentsDir: string,
 *   mtimeMs: number,
 *   sizeBytes: number,
 * }} SessionFile */

/**
 * Scan ~/.claude/projects/* for session transcripts, sorted by mtime desc.
 * A session is <projectDir>/<sessionId>.jsonl, optionally paired with
 * <projectDir>/<sessionId>/subagents/agent-*.jsonl for sidechains.
 * @returns {SessionFile[]}
 */
export function listSessions() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  /** @type {SessionFile[]} */
  const out = [];
  for (const projectDir of fs.readdirSync(PROJECTS_ROOT)) {
    const dirPath = path.join(PROJECTS_ROOT, projectDir);
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      const mainPath = path.join(dirPath, entry.name);
      let stat;
      try {
        stat = fs.statSync(mainPath);
      } catch {
        continue;
      }
      out.push({
        sessionId,
        projectDir: dirPath,
        mainPath,
        subagentsDir: path.join(dirPath, sessionId, 'subagents'),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export { PROJECTS_ROOT };

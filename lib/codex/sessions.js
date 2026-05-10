// @ts-check
// Locate Codex CLI conversation transcripts on disk and enumerate sessions.
//
// On-disk layout (Codex 0.130+):
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl
//
// CODEX_HOME defaults to ~/.codex. The session id is a UUID; the filename
// also carries an ISO-ish timestamp prefix but we don't parse it — mtime
// off the file stat is authoritative.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');

// rollout-<ts>-<uuid>.jsonl  — the UUID is the session id.
const ROLLOUT_RE = /^rollout-.+-([0-9a-fA-F-]{36})\.jsonl$/;

/**
 * Walk the YYYY/MM/DD tree and return one entry per discovered transcript.
 * Sorted mtime desc; sessionId asc as tiebreaker (stability across platforms
 * where readdir order isn't guaranteed).
 *
 * @returns {SessionFile[]}
 */
export function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  /** @type {SessionFile[]} */
  const out = [];

  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const m = entry.name.match(ROLLOUT_RE);
      if (!m) continue;
      const sessionId = m[1];
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({
        harness: 'codex',
        sessionId,
        mainPath: full,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  };

  walk(SESSIONS_ROOT);
  out.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return out;
}

export { CODEX_HOME, SESSIONS_ROOT };

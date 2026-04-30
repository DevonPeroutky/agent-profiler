// @ts-check
// Pure JSONL reader. Returns raw parsed records, nothing else.

import fs from 'node:fs';
import path from 'node:path';

/** @typedef {import('./sessions.js').SessionFile} SessionFile */

/** @typedef {Record<string, any>} TranscriptRecord */

/**
 * @typedef {{
 *   agentId: string,
 *   agentType: string | null,
 *   records: TranscriptRecord[],
 * }} SubagentTranscript
 */

/**
 * @typedef {{
 *   main: TranscriptRecord[],
 *   subagents: SubagentTranscript[],
 * }} TranscriptBundle
 */

/**
 * Claude Code appends to transcripts while a session is live. Reading mid-write
 * can leave a torn final line that isn't valid JSON. Strategy:
 *   1. Drop any trailing chunk that doesn't end in newline (potential partial write).
 *   2. Per-line try/catch so one bad record never fails the whole transcript.
 * @param {string} filePath
 * @returns {TranscriptRecord[]}
 */
function readJsonl(filePath) {
  /** @type {TranscriptRecord[]} */
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  for (const text of complete.split('\n')) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      // Stamp 0-based parse-order index. Equals the Debug tab's `#N` since
      // both numberings come from the same array (this function's output).
      parsed._rowIndex = out.length;
      out.push(parsed);
    } catch {
      // Silent skip — noisy warnings aren't useful for a read-heavy path.
    }
  }
  return out;
}

/**
 * Read a session's main transcript plus every sibling subagent transcript.
 * @param {SessionFile} file
 * @returns {TranscriptBundle}
 */
export function readTranscript(file) {
  const main = readJsonl(file.mainPath);
  /** @type {SubagentTranscript[]} */
  const subagents = [];
  if (fs.existsSync(file.subagentsDir)) {
    for (const entry of fs.readdirSync(file.subagentsDir)) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
      const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
      /** @type {string | null} */
      let agentType = null;
      const metaPath = path.join(file.subagentsDir, `agent-${agentId}.meta.json`);
      if (fs.existsSync(metaPath)) {
        try {
          agentType = JSON.parse(fs.readFileSync(metaPath, 'utf8')).agentType ?? null;
        } catch { /* ignore */ }
      }
      subagents.push({
        agentId,
        agentType,
        records: readJsonl(path.join(file.subagentsDir, entry)),
      });
    }
  }
  return { main, subagents };
}

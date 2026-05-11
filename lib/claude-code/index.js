// @ts-check
// Claude Code harness adapter. Reads ~/.claude/projects/<slug>/<sid>.jsonl
// plus paired subagent sidechains and emits TraceSummary[] via the existing
// pure transformer.

import { listSessions } from './sessions.js';
import { toTraces } from './traces.js';
import { readTranscript } from './transcripts.js';

/** @typedef {import('../adapters/types.d.ts').HarnessAdapter} HarnessAdapter */
/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */
/** @typedef {import('./sessions.js').SessionFile} ClaudeSessionFile */
/** @typedef {import('./transcripts.js').TranscriptBundle} TranscriptBundle */

/** @type {HarnessAdapter} */
export const claudeCode = {
  id: 'claude-code',
  discover() {
    return listSessions().map((f) => ({
      harness: 'claude-code',
      sessionId: f.sessionId,
      mainPath: f.mainPath,
      mtimeMs: f.mtimeMs,
      sizeBytes: f.sizeBytes,
      extras: { projectDir: f.projectDir, subagentsDir: f.subagentsDir },
    }));
  },
  read(file) {
    // Reconstruct the ClaudeSessionFile shape readTranscript expects.
    const extras = /** @type {{ projectDir?: string, subagentsDir?: string }} */ (
      file.extras ?? {}
    );
    /** @type {ClaudeSessionFile} */
    const claudeFile = {
      sessionId: file.sessionId,
      projectDir: extras.projectDir ?? '',
      mainPath: file.mainPath,
      subagentsDir: extras.subagentsDir ?? '',
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
    };
    return readTranscript(claudeFile);
  },
  transform(sessionId, bundle) {
    return toTraces(sessionId, /** @type {TranscriptBundle} */ (bundle));
  },
};

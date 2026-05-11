// @ts-check
// Codex rollout JSONL reader. Pure I/O — the transformer does all shaping.
//
// Each rollout row is { timestamp, type, payload } where type is one of
// session_meta, turn_context, event_msg, response_item. Read tolerance
// (CLAUDE.md §3) is the same shape as the Claude reader: drop torn final
// line, per-record try/catch, silent on skipped lines.
//
// Read-boundary filters (per plan v5):
//   - Drop session_meta.payload.base_instructions.text  (~10 KB system
//     prompt; surfacing it would inflate prompt previews to noise).
//   - Drop response_item type=message with role ∈ {user, developer}: these
//     are harness-injected replay (<environment_context>, system message,
//     duplicated user prompt). The real user prompt source is
//     event_msg.user_message.message.

import fs from 'node:fs';

/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */
/** @typedef {Record<string, any>} RolloutRow */
/** @typedef {{ rows: RolloutRow[] }} CodexBundle */

/**
 * Read one rollout file. Same torn-line / per-row tolerance pattern as the
 * Claude reader.
 *
 * @param {string} filePath
 * @returns {RolloutRow[]}
 */
export function readJsonl(filePath) {
  /** @type {RolloutRow[]} */
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
      parsed._rowIndex = out.length;
      out.push(parsed);
    } catch {
      // Silent skip — torn writes or corrupt rows shouldn't fail the session.
    }
  }
  return out;
}

/**
 * True iff this row should be filtered before the transformer sees it.
 * Centralised so the rule is the same whether the bundle is built from disk
 * or constructed in a test fixture (the transformer assumes filtered input).
 *
 * @param {RolloutRow} row
 * @returns {boolean}
 */
function shouldFilterRow(row) {
  if (!row || typeof row !== 'object') return true;
  if (row.type === 'response_item') {
    const p = row.payload;
    if (p && p.type === 'message') {
      const role = p.role;
      if (role === 'user' || role === 'developer') return true;
    }
  }
  return false;
}

/**
 * Sanitise session_meta in place by dropping the giant base_instructions text.
 * Keeps the rest of the payload (id, cwd, originator, cli_version, git, …).
 *
 * @param {RolloutRow} row
 */
function sanitizeSessionMeta(row) {
  if (row?.type !== 'session_meta') return;
  const bi = row.payload?.base_instructions;
  if (bi && typeof bi === 'object' && 'text' in bi) {
    // Replace the text with a marker; keep the wrapper so downstream code
    // can still spot that the session shipped a system prompt.
    row.payload.base_instructions = {
      ...bi,
      text: '[filtered: base_instructions.text]',
    };
  }
}

/**
 * @param {SessionFile} file
 * @returns {CodexBundle}
 */
export function readTranscript(file) {
  const rows = readJsonl(file.mainPath);
  const kept = [];
  for (const r of rows) {
    if (r.type === 'session_meta') sanitizeSessionMeta(r);
    if (shouldFilterRow(r)) continue;
    kept.push(r);
  }
  // Renumber _rowIndex over kept rows so the Debug tab's "#N" labels match
  // what the transformer iterates.
  for (let i = 0; i < kept.length; i++) kept[i]._rowIndex = i;
  return { rows: kept };
}

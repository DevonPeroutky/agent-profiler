// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  toTraces,
  ATTACHMENT_HANDLERS,
  KNOWN_GENERIC_ATTACHMENT_TYPES,
} from '../lib/traces/traces.js';

/**
 * Build a minimal valid record. The transformer ignores fields it doesn't
 * read; we only set what each test needs.
 * @param {Partial<Record<string, any>>} fields
 */
const rec = (fields) => ({
  type: 'user',
  uuid: Math.random().toString(36).slice(2),
  parentUuid: null,
  timestamp: '2026-04-23T12:00:00.000Z',
  ...fields,
});

const userPrompt = (text, t = '2026-04-23T12:00:00.000Z') =>
  rec({
    type: 'user',
    timestamp: t,
    message: { role: 'user', content: text },
  });

const attachmentRec = (att, t = '2026-04-23T12:00:01.000Z') =>
  rec({ type: 'attachment', timestamp: t, attachment: att });

const assistant = (content, t = '2026-04-23T12:00:02.000Z', requestId = 'req_1') =>
  rec({
    type: 'assistant',
    timestamp: t,
    requestId,
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });

const bundleOf = (records) => ({ main: records, subagents: [] });

// ──────────────────────────────────────────────────────────────────────────
// Acceptance #1: handler routing — specific handlers fire for known types,
// generic fallback fires only for un-handled types, no double-emit.

test('specific-handler attachments do not produce context.attachment events', () => {
  const records = [
    userPrompt('hi'),
    attachmentRec({
      type: 'hook_success',
      hookName: 'SessionStart:test',
      hookEvent: 'SessionStart',
      command: 'noop',
      stdout: 'OK',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    }),
    attachmentRec({ type: 'auto_mode', reminderType: 'full' }),
    attachmentRec({ type: 'plan_mode', reminderType: 'full', planExists: false }),
    attachmentRec({ type: 'plan_mode_exit', planExists: true }),
    attachmentRec({ type: 'command_permissions', allowedTools: ['Bash'] }),
    assistant([{ type: 'text', text: 'hello' }]),
  ];
  const [turn] = toTraces('s1', bundleOf(records));
  assert.equal(turn.kind, 'turn');
  const attachmentEvents = turn.root.events.filter(
    (e) => e.name === 'agent_trace.context.attachment',
  );
  assert.equal(attachmentEvents.length, 0, 'specific handlers should not double-emit');
  assert.equal(turn.attachmentCount, 0);
  assert.equal(turn.attachmentBytes, 0);
});

test('generic-fallback attachments produce one event each, with type and bytes', () => {
  const generics = [
    { type: 'task_reminder', content: [], itemCount: 0 },
    { type: 'nested_memory', path: '/p', displayPath: 'p', content: { type: 'Project', body: 'hello' } },
    { type: 'skill_listing', content: '- x: y', skillCount: 1, isInitial: true },
    { type: 'mcp_instructions_delta', addedNames: ['a'], removedNames: [], addedBlocks: ['# a'] },
    { type: 'deferred_tools_delta', addedNames: ['Foo'], removedNames: [], addedLines: [] },
    { type: 'edited_text_file', filename: 'a.ts', snippet: 'x = 1' },
    { type: 'queued_command', commandMode: 'queue', prompt: '/foo bar' },
    { type: 'file', filename: 'a.ts', displayPath: 'a.ts', content: { text: 'hi' } },
    { type: 'directory', path: '/d', displayPath: 'd', content: { entries: ['x'] } },
    { type: 'date_change', newDate: '2026-04-24' },
    { type: 'already_read_file', filename: 'a.ts', displayPath: 'a.ts', content: { text: 'hi' } },
  ];
  const records = [
    userPrompt('hi'),
    ...generics.map((a) => attachmentRec(a)),
    assistant([{ type: 'text', text: 'ok' }]),
  ];
  const [turn] = toTraces('s2', bundleOf(records));
  const attachmentEvents = turn.root.events.filter(
    (e) => e.name === 'agent_trace.context.attachment',
  );
  assert.equal(attachmentEvents.length, generics.length);
  for (let i = 0; i < generics.length; i++) {
    const ev = attachmentEvents[i];
    assert.equal(ev.attributes?.['agent_trace.attachment.type'], generics[i].type);
    const bytes = Number(ev.attributes?.['agent_trace.attachment.bytes']);
    assert.ok(bytes > 0, `bytes for ${generics[i].type} should be > 0`);
  }
  assert.equal(turn.attachmentCount, generics.length);
});

// ──────────────────────────────────────────────────────────────────────────
// Acceptance #3: roundtrip law.

test('per-turn attachmentBytes equals transcript-side total over un-handled records', () => {
  // Two turns, each with mixed attachments; some specific, some generic.
  const turn1Generics = [
    { type: 'nested_memory', content: { body: 'AAA' } },
    { type: 'skill_listing', content: 'x' },
  ];
  const turn2Generics = [
    { type: 'task_reminder', content: ['a', 'b'], itemCount: 2 },
  ];
  const records = [
    userPrompt('first', '2026-04-23T12:00:00.000Z'),
    ...turn1Generics.map((a) => attachmentRec(a, '2026-04-23T12:00:00.500Z')),
    attachmentRec({
      type: 'hook_success',
      hookName: 'X',
      hookEvent: 'PreToolUse',
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
    }, '2026-04-23T12:00:00.700Z'),
    assistant([{ type: 'text', text: 'one' }], '2026-04-23T12:00:01.000Z', 'req_a'),
    userPrompt('second', '2026-04-23T12:00:02.000Z'),
    ...turn2Generics.map((a) => attachmentRec(a, '2026-04-23T12:00:02.500Z')),
    assistant([{ type: 'text', text: 'two' }], '2026-04-23T12:00:03.000Z', 'req_b'),
  ];

  const traces = toTraces('s3', bundleOf(records));
  const turns = traces.filter((t) => t.kind === 'turn');
  const turnSum = turns.reduce((n, t) => n + (t.attachmentBytes ?? 0), 0);

  // Transcript-side total: every attachment record whose type is NOT in
  // ATTACHMENT_HANDLERS, sized via JSON.stringify (matches handler).
  const transcriptSum = records
    .filter((r) => r.type === 'attachment')
    .filter((r) => !ATTACHMENT_HANDLERS[r.attachment?.type])
    .reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.attachment), 'utf8'), 0);

  assert.equal(turnSum, transcriptSum);
  assert.ok(turnSum > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Acceptance #4: no regressions to subagent state / cross-slice invariants.

test('subagent buildSubagentSpan does not surface attachment bytes (out-of-scope per v2)', () => {
  // A subagent transcript with a nested_memory attachment should NOT bleed
  // into main turn's attachmentBytes nor produce events on the subagent span.
  const subagentRecords = [
    userPrompt('subtask', '2026-04-23T12:00:00.000Z'),
    attachmentRec({ type: 'nested_memory', content: { body: 'sub' } }, '2026-04-23T12:00:00.100Z'),
    assistant([{ type: 'text', text: 'sub-reply' }], '2026-04-23T12:00:00.500Z', 'req_sub'),
  ];
  const mainRecords = [
    userPrompt('hi', '2026-04-23T12:00:01.000Z'),
    rec({
      type: 'assistant',
      timestamp: '2026-04-23T12:00:02.000Z',
      requestId: 'req_main',
      message: {
        id: 'msg_main',
        role: 'assistant',
        model: 'claude-test',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Agent', input: { prompt: 'do thing' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }),
    rec({
      type: 'user',
      timestamp: '2026-04-23T12:00:03.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'done', is_error: false },
        ],
      },
      toolUseResult: { agentId: 'a-sub' },
    }),
  ];
  const traces = toTraces('s4', {
    main: mainRecords,
    subagents: [{ agentId: 'a-sub', agentType: 'general-purpose', records: subagentRecords }],
  });
  const turn = traces.find((t) => t.kind === 'turn');
  assert.ok(turn);
  // Main turn's attachmentBytes is zero — no attachments on the main slice.
  assert.equal(turn.attachmentBytes, 0);
  assert.equal(turn.attachmentCount, 0);
  // The subagent subtree is reachable via the Agent tool span.
  const findSubagent = (node) => {
    if (node.attributes?.['agent_trace.event_type'] === 'subagent') return node;
    for (const c of node.children) {
      const hit = findSubagent(c);
      if (hit) return hit;
    }
    return null;
  };
  const subSpan = findSubagent(turn.root);
  assert.ok(subSpan, 'subagent span exists');
  const subAttachmentEvents = subSpan.events.filter(
    (e) => e.name === 'agent_trace.context.attachment',
  );
  assert.equal(subAttachmentEvents.length, 0, 'subagent attachments are out of scope in v2');
});

// ──────────────────────────────────────────────────────────────────────────
// Acceptance #2: catalog-drift test against on-disk transcripts.

test('catalog-drift: every observed attachment.type is classified', { skip: false }, () => {
  const projectsDir = path.join(
    os.homedir(),
    '.claude',
    'projects',
    '-Users-devonperoutky-Development-projects-claude-code-plugins-devon-marketplace',
  );
  if (!fs.existsSync(projectsDir)) {
    // Fresh checkouts won't have this directory; treat as a no-op rather than
    // a failure. The drift signal only matters where the harness is running.
    return;
  }
  const sessions = fs
    .readdirSync(projectsDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => ({
      name: n,
      mtime: fs.statSync(path.join(projectsDir, n)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5)
    .map((f) => path.join(projectsDir, f.name));

  const observed = new Set();
  for (const fp of sessions) {
    const raw = fs.readFileSync(fp, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === 'attachment' && obj.attachment?.type) {
          observed.add(obj.attachment.type);
        }
      } catch { /* ignore torn lines */ }
    }
  }
  const known = new Set([
    ...Object.keys(ATTACHMENT_HANDLERS),
    ...KNOWN_GENERIC_ATTACHMENT_TYPES,
  ]);
  const unknown = [...observed].filter((t) => !known.has(t));
  assert.deepEqual(
    unknown,
    [],
    `unclassified attachment subtypes: ${unknown.join(', ')}.\n` +
      `Add a specific handler in ATTACHMENT_HANDLERS or list in ` +
      `KNOWN_GENERIC_ATTACHMENT_TYPES.`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Acceptance #5: qualitative — the user can explain a context spike.

test('user can identify a nested_memory-driven spike from turn fields alone', () => {
  // Simulates the 8.9k spike scenario: a single nested_memory inclusion
  // dwarfs all other attachments in the turn.
  const records = [
    userPrompt('go'),
    attachmentRec({ type: 'task_reminder', content: [], itemCount: 0 }),
    attachmentRec({
      type: 'nested_memory',
      path: '/p/CLAUDE.md',
      displayPath: 'CLAUDE.md',
      content: { type: 'Project', body: 'X'.repeat(8000) },
    }),
    attachmentRec({ type: 'date_change', newDate: '2026-04-24' }),
    assistant([{ type: 'text', text: 'ok' }]),
  ];
  const [turn] = toTraces('s5', bundleOf(records));
  assert.equal(turn.attachmentCount, 3);
  assert.ok(turn.attachmentBytes > 8000, 'nested_memory dominates the byte total');

  const events = turn.root.events.filter(
    (e) => e.name === 'agent_trace.context.attachment',
  );
  const top = events.reduce((a, b) =>
    Number(b.attributes?.['agent_trace.attachment.bytes']) >
    Number(a.attributes?.['agent_trace.attachment.bytes']) ? b : a,
  );
  assert.equal(top.attributes?.['agent_trace.attachment.type'], 'nested_memory');
});

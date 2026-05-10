// @ts-nocheck
// Codex adapter — transformer-focused tests. In-memory fixtures (per-row
// objects) drive the transformer directly. Spot-check against the real
// rollout file at the bottom to lock down headline counts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codex } from '../lib/codex/index.js';
import { toTraces } from '../lib/codex/traces.js';

const SID = '11111111-1111-1111-1111-111111111111';

/** Helpers — build the minimal valid row shapes the transformer reads. */
const sessionMeta = (ts, cwd = '/tmp/x') => ({
  type: 'session_meta',
  timestamp: ts,
  payload: { id: SID, cwd, originator: 'test', cli_version: 'x' },
});

const taskStarted = (ts, turnId) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: { type: 'task_started', turn_id: turnId },
});

const taskComplete = (ts, turnId) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: { type: 'task_complete', turn_id: turnId },
});

const turnAborted = (ts, turnId, reason = 'interrupted') => ({
  type: 'event_msg',
  timestamp: ts,
  payload: { type: 'turn_aborted', turn_id: turnId, reason },
});

const userMessage = (ts, msg) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: { type: 'user_message', message: msg },
});

const turnContext = (ts, turnId, model = 'gpt-test', cwd = '/tmp/x') => ({
  type: 'turn_context',
  timestamp: ts,
  payload: { turn_id: turnId, model, cwd },
});

const tokenCount = (ts, input, output, cached = 0, reasoning = 0) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

const reasoning = (ts) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'x'.repeat(200) },
});

const assistantMessage = (ts, text) => ({
  type: 'response_item',
  timestamp: ts,
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  },
});

const functionCall = (ts, callId, name, args) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'function_call', call_id: callId, name, arguments: args },
});

const functionCallOutput = (ts, callId, output) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'function_call_output', call_id: callId, output },
});

const customToolCall = (ts, callId, name, input) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'custom_tool_call', status: 'completed', call_id: callId, name, input },
});

const customToolCallOutput = (ts, callId, output) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'custom_tool_call_output', call_id: callId, output },
});

const webSearchCall = (ts, queries) => ({
  type: 'response_item',
  timestamp: ts,
  payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', queries } },
});

/** Run the transformer on raw rows (skipping the read-boundary filter). */
const transform = (rows) => toTraces(SID, { rows });

// ─────────────────────────────────────────────────────────────────────────────

test('codex: single turn with one inference, no tools', () => {
  const rows = [
    sessionMeta('2026-01-01T00:00:00.000Z'),
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1', 'gpt-5'),
    userMessage('2026-01-01T00:00:01.000Z', 'hello'),
    reasoning('2026-01-01T00:00:02.000Z'),
    assistantMessage('2026-01-01T00:00:02.500Z', 'hi there'),
    tokenCount('2026-01-01T00:00:03.000Z', 100, 10, 0, 5),
    taskComplete('2026-01-01T00:00:04.000Z', 'T1'),
  ];
  const traces = transform(rows);
  assert.equal(traces.length, 1);
  const t = traces[0];
  assert.equal(t.kind, 'turn');
  assert.equal(t.turnNumber, 1);
  assert.equal(t.userPrompt, 'hello');
  assert.equal(t.model, 'gpt-5');
  assert.equal(t.isRunning, false);
  assert.equal(t.isMeta, false);
  assert.equal(t.finalMode, null);
  assert.equal(t.attachmentCount, 0);
  // One inference for the one token_count
  assert.equal(t.root.children.length, 1);
  const inf = t.root.children[0];
  assert.equal(inf.name, 'inference');
  assert.equal(inf.attributes['agent_trace.inference.request_id'], 'T1:0');
  assert.equal(inf.attributes['agent_trace.inference.kind'], 'mixed'); // reasoning + message
  assert.equal(inf.attributes['gen_ai.usage.input_tokens'], 100);
  // output_tokens = output + reasoning_output (folded)
  assert.equal(inf.attributes['gen_ai.usage.output_tokens'], 15);
  // Turn-level token totals match folded values
  assert.equal(t.contextTokens.input, 100);
  assert.equal(t.contextTokens.output, 15);
  // No tools
  assert.equal(t.toolCount, 0);
  assert.equal(inf.children.length, 0);
});

test('codex: function_call paired with function_call_output by call_id', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1', 'gpt-5'),
    userMessage('2026-01-01T00:00:01.000Z', 'run ls'),
    reasoning('2026-01-01T00:00:02.000Z'),
    functionCall('2026-01-01T00:00:02.100Z', 'c1', 'exec_command', '{"cmd":"ls"}'),
    tokenCount('2026-01-01T00:00:02.200Z', 100, 5, 0, 3),
    functionCallOutput(
      '2026-01-01T00:00:03.000Z',
      'c1',
      'Chunk ID: aa\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nfile.txt\n',
    ),
    reasoning('2026-01-01T00:00:03.500Z'),
    assistantMessage('2026-01-01T00:00:03.600Z', 'done'),
    tokenCount('2026-01-01T00:00:04.000Z', 200, 10, 100, 5),
    taskComplete('2026-01-01T00:00:05.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  // Two inferences (two token_counts)
  assert.equal(t.root.children.length, 2);
  const inf1 = t.root.children[0];
  // Tool span parents to inf1 (the inference whose block emitted the *_call),
  // NOT inf2 (the inference whose block contains the *_call_output).
  assert.equal(inf1.children.length, 1, 'tool span should nest under inf1');
  assert.equal(t.root.children[1].children.length, 0);
  const tool = inf1.children[0];
  assert.equal(tool.name, 'exec_command');
  assert.equal(tool.attributes['agent_trace.tool.use_id'], 'c1');
  assert.match(String(tool.attributes['agent_trace.tool.output_summary']), /file\.txt/);
  // Duration is output.ts - call.ts (structurally paired)
  assert.ok(tool.durationMs > 0);
  // Error detection: exit code 0 → no error
  assert.equal(tool.status, undefined);
  assert.equal(t.toolCount, 1);
  assert.equal(t.errorCount, 0);
});

test('codex: tool error detected from non-zero exit code', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'run failing cmd'),
    functionCall('2026-01-01T00:00:02.000Z', 'c2', 'exec_command', '{"cmd":"false"}'),
    tokenCount('2026-01-01T00:00:02.500Z', 50, 5),
    functionCallOutput(
      '2026-01-01T00:00:03.000Z',
      'c2',
      'Wall time: 0.01s\nProcess exited with code 1\nOutput:\n',
    ),
    taskComplete('2026-01-01T00:00:04.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  const tool = t.root.children[0].children[0];
  assert.equal(tool.status?.code, 2);
  assert.equal(t.errorCount, 1);
});

test('codex: custom_tool_call (apply_patch) with metadata.exit_code', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'apply patch'),
    customToolCall(
      '2026-01-01T00:00:02.000Z',
      'cc1',
      'apply_patch',
      '*** Begin Patch\n*** End Patch',
    ),
    tokenCount('2026-01-01T00:00:02.500Z', 50, 5),
    customToolCallOutput(
      '2026-01-01T00:00:03.000Z',
      'cc1',
      '{"output":"ok","metadata":{"exit_code":0,"duration_seconds":0.1}}',
    ),
    taskComplete('2026-01-01T00:00:04.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  const tool = t.root.children[0].children[0];
  assert.equal(tool.name, 'apply_patch');
  assert.equal(tool.status, undefined);
  // Now exit_code: 1
  rows[5] = customToolCallOutput(
    '2026-01-01T00:00:03.000Z',
    'cc1',
    '{"output":"bad","metadata":{"exit_code":1}}',
  );
  const t2 = transform(rows)[0];
  assert.equal(t2.root.children[0].children[0].status?.code, 2);
});

test('codex: in-flight turn (no terminal) → isRunning: true', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'long task'),
    reasoning('2026-01-01T00:00:02.000Z'),
    tokenCount('2026-01-01T00:00:03.000Z', 100, 5),
    // no task_complete, no turn_aborted
  ];
  const t = transform(rows)[0];
  assert.equal(t.isRunning, true);
  assert.equal(t.root.attributes['agent_trace.in_progress'], true);
  assert.notEqual(t.root.attributes['agent_trace.turn.aborted'], true);
});

test('codex: aborted turn → isRunning: false + agent_trace.turn.aborted: true', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'will be cancelled'),
    reasoning('2026-01-01T00:00:02.000Z'),
    tokenCount('2026-01-01T00:00:03.000Z', 100, 5),
    turnAborted('2026-01-01T00:00:04.000Z', 'T1', 'interrupted'),
  ];
  const t = transform(rows)[0];
  assert.equal(t.isRunning, false);
  assert.equal(t.root.attributes['agent_trace.turn.aborted'], true);
});

test('codex: zero-inference turn (aborted before first token_count) → truncated', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'fast abort'),
    // No token_count, just orphaned reasoning + an orphan call
    reasoning('2026-01-01T00:00:01.500Z'),
    functionCall('2026-01-01T00:00:01.700Z', 'orphan1', 'exec_command', '{}'),
    turnAborted('2026-01-01T00:00:02.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  assert.equal(t.root.children.length, 0); // no inference
  assert.equal(t.root.attributes['agent_trace.turn.truncated'], true);
  assert.equal(t.root.attributes['agent_trace.turn.aborted'], true);
  assert.equal(t.toolCount, 0); // orphaned *_call dropped
  assert.equal(t.contextTokens.input, 0);
});

test('codex: multi-turn — slicing by task_started boundary', () => {
  const rows = [
    sessionMeta('2026-01-01T00:00:00.000Z'),
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'first'),
    tokenCount('2026-01-01T00:00:02.000Z', 100, 5),
    taskComplete('2026-01-01T00:00:03.000Z', 'T1'),
    taskStarted('2026-01-01T00:00:04.000Z', 'T2'),
    turnContext('2026-01-01T00:00:04.000Z', 'T2'),
    userMessage('2026-01-01T00:00:04.000Z', 'second'),
    tokenCount('2026-01-01T00:00:05.000Z', 200, 10),
    tokenCount('2026-01-01T00:00:06.000Z', 250, 15),
    taskComplete('2026-01-01T00:00:07.000Z', 'T2'),
  ];
  const traces = transform(rows);
  assert.equal(traces.length, 2);
  assert.equal(traces[0].userPrompt, 'first');
  assert.equal(traces[1].userPrompt, 'second');
  assert.equal(traces[0].root.attributes['agent_trace.turn.request_count'], 1);
  assert.equal(traces[1].root.attributes['agent_trace.turn.request_count'], 2);
  // Synthetic request_ids carry the proper turn_id
  assert.equal(traces[1].root.children[0].attributes['agent_trace.inference.request_id'], 'T2:0');
  assert.equal(traces[1].root.children[1].attributes['agent_trace.inference.request_id'], 'T2:1');
});

test('codex: cached input is subtracted to get incremental input', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'p'),
    tokenCount('2026-01-01T00:00:02.000Z', 1000, 50, 800, 10),
    taskComplete('2026-01-01T00:00:03.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  // input = input_tokens - cached_input_tokens = 1000 - 800 = 200
  assert.equal(t.contextTokens.input, 200);
  assert.equal(t.contextTokens.cacheRead, 800);
  assert.equal(t.contextTokens.cacheCreation, 0);
  // output = output_tokens + reasoning_output_tokens
  assert.equal(t.contextTokens.output, 60);
});

test('codex: web_search_call emitted as leaf tool span', () => {
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'search'),
    reasoning('2026-01-01T00:00:02.000Z'),
    webSearchCall('2026-01-01T00:00:02.200Z', ['formspree docs', 'netlify forms']),
    tokenCount('2026-01-01T00:00:03.000Z', 100, 5),
    taskComplete('2026-01-01T00:00:04.000Z', 'T1'),
  ];
  const t = transform(rows)[0];
  assert.equal(t.toolCount, 1);
  const ws = t.root.children[0].children[0];
  assert.equal(ws.name, 'web_search');
  assert.match(String(ws.attributes['agent_trace.tool.input_summary']), /formspree docs/);
  assert.equal(ws.status, undefined); // completed
});

test('codex: registry runTransform stamps harness + prefixes traceId', async () => {
  const { runTransform } = await import('../lib/adapters/registry.js');
  const rows = [
    taskStarted('2026-01-01T00:00:01.000Z', 'T1'),
    turnContext('2026-01-01T00:00:01.000Z', 'T1'),
    userMessage('2026-01-01T00:00:01.000Z', 'p'),
    tokenCount('2026-01-01T00:00:02.000Z', 100, 5),
    taskComplete('2026-01-01T00:00:03.000Z', 'T1'),
  ];
  const traces = runTransform(codex, SID, { rows });
  assert.equal(traces[0].traceId, `codex:${SID}:turn:1`);
  assert.equal(traces[0].root.attributes['agent_trace.harness'], 'codex');
});

test('codex: transcripts.readTranscript filters base_instructions.text + replay messages', async () => {
  const { readTranscript } = await import('../lib/codex/transcripts.js');
  const tmp = path.join(os.tmpdir(), `codex-read-test-${Date.now()}.jsonl`);
  const rows = [
    {
      type: 'session_meta',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        id: SID,
        cwd: '/tmp',
        base_instructions: { text: 'x'.repeat(10000) },
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: { type: 'task_started', turn_id: 'T1' },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions>' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>' }],
      },
    },
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: { type: 'user_message', message: 'real prompt' },
    },
  ];
  fs.writeFileSync(tmp, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  try {
    const bundle = readTranscript({
      harness: 'codex',
      sessionId: SID,
      mainPath: tmp,
      mtimeMs: 0,
      sizeBytes: 0,
    });
    // 5 rows in → 3 rows out (dropped developer + user replay; sanitized session_meta stays)
    assert.equal(bundle.rows.length, 3);
    const meta = bundle.rows[0];
    assert.equal(meta.type, 'session_meta');
    assert.equal(meta.payload.base_instructions.text, '[filtered: base_instructions.text]');
    assert.equal(bundle.rows[1].payload.type, 'task_started');
    assert.equal(bundle.rows[2].payload.type, 'user_message');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Real-fixture lockdown — only runs if the original session is on disk. Locks
// the headline counts against regressions in turn slicing / inference rules.

const REAL_FIXTURE =
  '/Users/devonperoutky/.codex/sessions/2026/05/10/rollout-2026-05-10T14-55-33-019e13e3-7247-7a62-84b0-0f90994255aa.jsonl';

test(
  'codex: real fixture lockdown (8 turns, 46 token_counts, 1 aborted)',
  { skip: !fs.existsSync(REAL_FIXTURE) },
  () => {
    const sid = '019e13e3-7247-7a62-84b0-0f90994255aa';
    const stat = fs.statSync(REAL_FIXTURE);
    const file = {
      harness: 'codex',
      sessionId: sid,
      mainPath: REAL_FIXTURE,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    };
    const bundle = codex.read(file);
    const traces = codex.transform(sid, bundle);
    assert.equal(traces.length, 8);
    const totalInferences = traces.reduce(
      (n, t) => n + Number(t.root.attributes['agent_trace.turn.request_count']),
      0,
    );
    assert.equal(totalInferences, 46);
    // Turn 5 was the aborted one in this transcript.
    const aborted = traces.find((t) => t.root.attributes['agent_trace.turn.aborted'] === true);
    assert.ok(aborted, 'expected exactly one aborted turn');
    assert.equal(aborted.turnNumber, 5);
    assert.equal(aborted.root.attributes['agent_trace.turn.truncated'], true);
    // All turns share the model from turn_context.
    for (const t of traces) {
      assert.equal(typeof t.model, 'string');
      assert.match(t.model, /^gpt-/);
    }
  },
);

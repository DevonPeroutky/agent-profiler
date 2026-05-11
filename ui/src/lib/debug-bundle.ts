// Harness-aware normalization for the Debug tab.
//
// The Debug tab shows the raw on-disk bundle, which means it intrinsically
// needs to know what each harness's bundle looks like. That knowledge is
// concentrated here so `ConversationDebug.tsx` can stay a pure renderer over
// `DebugGroup[]`. Adding a third harness = add a `case` arm + a `<harness>Groups`
// function. The component is untouched.

export type DebugRecord = Record<string, unknown>;

export interface DebugSummary {
  type: string;
  preview: string;
}

export interface DebugGroup {
  title: string;
  subtitle: string;
  records: DebugRecord[];
  summarize: (record: DebugRecord) => DebugSummary;
  defaultOpen?: boolean;
}

export function bundleToGroups(harness: string, bundle: unknown): DebugGroup[] {
  switch (harness) {
    case 'claude-code':
      return claudeGroups(bundle);
    case 'codex':
      return codexGroups(bundle);
    default:
      return rawGroup(bundle);
  }
}

// ---------------------------------------------------------------------------
// Claude Code: { main: TranscriptRecord[], subagents: SubagentTranscript[] }
// ---------------------------------------------------------------------------

interface ClaudeSubagent {
  agentId: string;
  agentType: string | null;
  records: DebugRecord[];
}

function claudeGroups(bundle: unknown): DebugGroup[] {
  const b = (bundle ?? {}) as { main?: DebugRecord[]; subagents?: ClaudeSubagent[] };
  const main = b.main ?? [];
  const subagents = b.subagents ?? [];
  const groups: DebugGroup[] = [
    {
      title: 'Main transcript',
      subtitle: `${main.length} record${main.length === 1 ? '' : 's'}`,
      records: main,
      summarize: claudeSummarize,
      defaultOpen: true,
    },
  ];
  for (const sa of subagents) {
    groups.push({
      title: `Subagent ${sa.agentType ?? 'unknown'}`,
      subtitle: `${sa.records.length} record${sa.records.length === 1 ? '' : 's'} · ${sa.agentId}`,
      records: sa.records,
      summarize: claudeSummarize,
    });
  }
  return groups;
}

function claudeSummarize(record: DebugRecord): DebugSummary {
  const rawType = String(record.type ?? 'unknown');
  let hasToolResult = false;
  const preview = (() => {
    const message = record.message;
    if (message && typeof message === 'object') {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return collapse(content);
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          const kind = String(b.type ?? '');
          if (kind === 'text' && typeof b.text === 'string') {
            parts.push(collapse(b.text));
          } else if (kind === 'thinking' && typeof b.thinking === 'string') {
            parts.push(`[thinking] ${collapse(b.thinking)}`);
          } else if (kind === 'tool_use') {
            parts.push(`[tool_use ${String(b.name ?? '')}]`);
          } else if (kind === 'tool_result') {
            hasToolResult = true;
            const tid = String(b.tool_use_id ?? '');
            parts.push(`[tool_result ${tid.slice(0, 12)}…]`);
          } else {
            parts.push(`[${kind}]`);
          }
        }
        return parts.join(' · ');
      }
    }
    if (typeof record.summary === 'string') return collapse(record.summary);
    return Object.keys(record).slice(0, 8).join(', ');
  })();
  const type = rawType === 'user' && hasToolResult ? 'tool' : rawType;
  return { type, preview };
}

// ---------------------------------------------------------------------------
// Codex: { rows: RolloutRow[] } — row.type ∈ session_meta | turn_context |
// event_msg | response_item; payload shape depends on type.
// ---------------------------------------------------------------------------

function codexGroups(bundle: unknown): DebugGroup[] {
  const b = (bundle ?? {}) as { rows?: DebugRecord[] };
  const rows = b.rows ?? [];
  return [
    {
      title: 'Rollout rows',
      subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}`,
      records: rows,
      summarize: codexSummarize,
      defaultOpen: true,
    },
  ];
}

function codexSummarize(record: DebugRecord): DebugSummary {
  const rowType = String(record.type ?? 'unknown');
  const payload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : {};
  const payloadType = typeof payload.type === 'string' ? payload.type : '';

  // Map onto the badge palette where possible (user / assistant / tool / system),
  // otherwise surface the most informative sub-type and let it render grey.
  const type = (() => {
    if (rowType === 'response_item') {
      if (payloadType === 'message') {
        const role = String(payload.role ?? '');
        return role || 'message';
      }
      if (payloadType === 'function_call' || payloadType === 'function_call_output') return 'tool';
      return payloadType || rowType;
    }
    if (rowType === 'event_msg') {
      if (payloadType === 'user_message') return 'user';
      return payloadType || rowType;
    }
    if (rowType === 'session_meta' || rowType === 'turn_context') return 'system';
    return rowType;
  })();

  const preview = codexPreview(rowType, payloadType, payload, record);
  return { type, preview };
}

function codexPreview(
  rowType: string,
  payloadType: string,
  payload: Record<string, unknown>,
  record: DebugRecord,
): string {
  if (rowType === 'session_meta') {
    const id = typeof payload.id === 'string' ? `${payload.id.slice(0, 8)}…` : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const cli = typeof payload.cli_version === 'string' ? payload.cli_version : '';
    return [id && `id=${id}`, cwd && `cwd=${cwd}`, cli && `cli=${cli}`].filter(Boolean).join(' · ');
  }
  if (rowType === 'turn_context') {
    const tid = typeof payload.turn_id === 'string' ? `${payload.turn_id.slice(0, 8)}…` : '';
    const model = typeof payload.model === 'string' ? payload.model : '';
    return [tid && `turn=${tid}`, model && `model=${model}`].filter(Boolean).join(' · ');
  }
  if (rowType === 'event_msg') {
    if (payloadType === 'user_message' && typeof payload.message === 'string') {
      return collapse(payload.message);
    }
    if (payloadType === 'token_count') {
      const info =
        payload.info && typeof payload.info === 'object'
          ? (payload.info as Record<string, unknown>)
          : {};
      const last =
        info.last_token_usage && typeof info.last_token_usage === 'object'
          ? (info.last_token_usage as Record<string, unknown>)
          : {};
      return `in=${last.input_tokens ?? 0} out=${last.output_tokens ?? 0} cached=${last.cached_input_tokens ?? 0}`;
    }
    if (payloadType === 'task_started' || payloadType === 'task_complete') {
      const tid = typeof payload.turn_id === 'string' ? `${payload.turn_id.slice(0, 8)}…` : '';
      return tid ? `turn=${tid}` : payloadType;
    }
    if (payloadType === 'turn_aborted') {
      const tid = typeof payload.turn_id === 'string' ? `${payload.turn_id.slice(0, 8)}…` : '';
      const reason = typeof payload.reason === 'string' ? payload.reason : '';
      return [tid && `turn=${tid}`, reason && `reason=${reason}`].filter(Boolean).join(' · ');
    }
    return `[${payloadType || 'event'}]`;
  }
  if (rowType === 'response_item') {
    if (payloadType === 'message') {
      const role = String(payload.role ?? '');
      const content = payload.content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          const k = String(b.type ?? '');
          if ((k === 'output_text' || k === 'input_text') && typeof b.text === 'string') {
            parts.push(collapse(b.text));
          } else {
            parts.push(`[${k}]`);
          }
        }
        return `${role}: ${parts.join(' · ')}`;
      }
      return role;
    }
    if (payloadType === 'function_call') {
      const name = String(payload.name ?? '');
      const cid = typeof payload.call_id === 'string' ? `${payload.call_id.slice(0, 12)}…` : '';
      return `${name} call=${cid}`;
    }
    if (payloadType === 'function_call_output') {
      const cid = typeof payload.call_id === 'string' ? `${payload.call_id.slice(0, 12)}…` : '';
      const out = typeof payload.output === 'string' ? collapse(payload.output) : '';
      return [`call=${cid}`, out].filter(Boolean).join(' · ');
    }
    if (payloadType === 'reasoning') return '[reasoning]';
    return `[${payloadType || 'response_item'}]`;
  }
  return Object.keys(record).slice(0, 8).join(', ');
}

// ---------------------------------------------------------------------------
// Unknown harness — show the raw bundle as a single record so the tab still
// renders something usable while a future adapter is being wired up.
// ---------------------------------------------------------------------------

function rawGroup(bundle: unknown): DebugGroup[] {
  const record: DebugRecord = { bundle: bundle as unknown };
  return [
    {
      title: 'Raw bundle',
      subtitle: 'unknown harness',
      records: [record],
      summarize: () => ({ type: 'unknown', preview: '' }),
      defaultOpen: true,
    },
  ];
}

function collapse(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

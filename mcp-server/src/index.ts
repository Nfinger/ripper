#!/usr/bin/env node
/**
 * Symphony MCP server (stdio).
 *
 * Exposes Symphony's HTTP API as MCP tools so Nano (or any MCP-aware agent)
 * can ask "what's Symphony doing right now" and trigger an immediate refresh.
 *
 * Symphony itself is unchanged — this is a pure HTTP client that translates
 * the JSON responses into structured tool output. Symphony does not need to
 * be on the same machine, but in our deployment it is.
 *
 * Read-only by default. Wakes up Symphony's poll cycle via /api/v1/refresh
 * but never writes Linear/Jira state — that remains the orchestrator's job.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4321';
const baseUrl = (process.env.SYMPHONY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');

interface ToolError {
  ok: false;
  code:
    | 'symphony_unreachable'
    | 'symphony_http_error'
    | 'symphony_bad_payload'
    | 'issue_not_found';
  message: string;
}

async function http<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; value: T } | ToolError> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      ...init,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'symphony_unreachable',
      message: `Symphony daemon is not reachable at ${baseUrl} — is it running? (\`bin/symphonyctl status\`). Underlying: ${(err as Error).message}`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      code: 'issue_not_found',
      message: `Symphony has no record of that issue (${path})`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: 'symphony_http_error',
      message: `Symphony API returned HTTP ${res.status} for ${path}`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      code: 'symphony_bad_payload',
      message: `Symphony response was not valid JSON: ${(err as Error).message}`,
    };
  }
  return { ok: true, value: body as T };
}

interface RunningRow {
  client: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_event_at: string | null;
  started_at: string;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}
interface RetryRow {
  client: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}
interface ProfileRow {
  name: string;
  tracker_kind: string;
  team_key: string | null;
  project_slug: string | null;
  workspace_root: string;
  counts: { running: number; retrying: number; completed_total: number };
}
interface StateResponse {
  generated_at: string;
  counts: { running: number; retrying: number; profiles: number };
  running: RunningRow[];
  retrying: RetryRow[];
  profiles: ProfileRow[];
  claude_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
}

function summarizeRunning(row: RunningRow): string {
  const startedSecondsAgo = Math.round((Date.now() - Date.parse(row.started_at)) / 1000);
  const lastEvent = row.last_event ?? 'no events yet';
  const tokens = row.tokens.total_tokens
    ? ` · ${row.tokens.total_tokens} tokens`
    : '';
  return `[${row.client}] ${row.issue_identifier} (${row.state}, turn ${row.turn_count}, started ${formatDuration(startedSecondsAgo)} ago, last: ${lastEvent}${tokens})`;
}

function summarizeRetry(row: RetryRow): string {
  const dueInSeconds = Math.round((Date.parse(row.due_at) - Date.now()) / 1000);
  const due = dueInSeconds <= 0 ? 'now' : `in ${formatDuration(dueInSeconds)}`;
  const reason = row.error ? ` — ${row.error}` : '';
  return `[${row.client}] ${row.issue_identifier} attempt ${row.attempt} retries ${due}${reason}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

const server = new McpServer({
  name: 'symphony',
  version: '0.1.0',
});

server.tool(
  'symphony_status',
  'Get a snapshot of every Symphony client profile: which issues are running, which are retrying, and aggregate token/runtime totals. No arguments. Use this when the user asks "what is Symphony working on?" or "is Symphony doing anything?"',
  {},
  async () => {
    const res = await http<StateResponse>('/api/v1/state');
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: res.message }],
        isError: true,
      };
    }
    const s = res.value;
    const lines: string[] = [];
    lines.push(`Symphony has ${s.counts.profiles} client profile(s) loaded:`);
    for (const p of s.profiles) {
      const scope = p.team_key
        ? `team ${p.team_key}`
        : p.project_slug
          ? `project ${p.project_slug}`
          : '?';
      lines.push(`  - ${p.name} (${p.tracker_kind} ${scope}): ${p.counts.running} running, ${p.counts.retrying} retrying, ${p.counts.completed_total} completed`);
    }
    lines.push('');
    if (s.running.length === 0) {
      lines.push('No issues currently running.');
    } else {
      lines.push(`Running (${s.running.length}):`);
      for (const r of s.running) lines.push(`  - ${summarizeRunning(r)}`);
    }
    if (s.retrying.length > 0) {
      lines.push('');
      lines.push(`Retrying (${s.retrying.length}):`);
      for (const r of s.retrying) lines.push(`  - ${summarizeRetry(r)}`);
    }
    lines.push('');
    lines.push(
      `Aggregate: ${s.claude_totals.total_tokens} tokens, ${formatDuration(Math.round(s.claude_totals.seconds_running))} of session runtime`,
    );
    return {
      content: [
        { type: 'text', text: lines.join('\n') },
        { type: 'text', text: '```json\n' + JSON.stringify(s, null, 2) + '\n```' },
      ],
    };
  },
);

server.tool(
  'symphony_issue_detail',
  "Look up the live status of a specific issue Symphony is working on by its tracker identifier (e.g. 'MFL-30', 'TH-12', 'MAR-5'). Returns running session details, retry queue position, or 404 if Symphony has no record.",
  {
    identifier: z
      .string()
      .min(1)
      .describe("Tracker identifier like 'MFL-30' or 'TH-12'"),
  },
  async ({ identifier }) => {
    const res = await http<unknown>(`/api/v1/${encodeURIComponent(identifier)}`);
    if (!res.ok) {
      const text =
        res.code === 'issue_not_found'
          ? `Symphony has no record of ${identifier} — it may not be in an active state, may not be in a configured project, or may not have been picked up yet.`
          : res.message;
      return { content: [{ type: 'text', text }], isError: res.code !== 'issue_not_found' };
    }
    return {
      content: [
        { type: 'text', text: `Symphony detail for ${identifier}:` },
        { type: 'text', text: '```json\n' + JSON.stringify(res.value, null, 2) + '\n```' },
      ],
    };
  },
);

server.tool(
  'symphony_refresh',
  'Trigger an immediate Linear/Jira poll + reconcile across all client profiles. Use this when a user just changed an issue state in their tracker and wants Symphony to pick it up right now without waiting for the next 60s tick. Returns the list of profiles that were nudged.',
  {},
  async () => {
    const res = await http<{ queued: boolean; profiles: string[] }>('/api/v1/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: res.message }], isError: true };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Triggered immediate poll across ${res.value.profiles.length} profile(s): ${res.value.profiles.join(', ')}.`,
        },
      ],
    };
  },
);

server.tool(
  'symphony_health',
  'Quick liveness check: confirms the Symphony daemon is reachable and reports the daemon URL. Use this if you suspect Symphony might be down.',
  {},
  async () => {
    const res = await http<StateResponse>('/api/v1/state');
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `Symphony NOT reachable at ${baseUrl}: ${res.message}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Symphony is reachable at ${baseUrl}. ${res.value.counts.profiles} profile(s) loaded; ${res.value.counts.running} running, ${res.value.counts.retrying} retrying.`,
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

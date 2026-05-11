import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { Daemon, ProfileRuntime } from '../daemon.js';
import { log } from '../log.js';
import type { OrchestratorState, RetryEntry, RunningEntry } from '../orchestrator/state.js';

export interface HttpServerOptions {
  port: number;
  bindHost: string;
  daemon: Daemon;
}

export interface HttpServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createHttpServer(opts: HttpServerOptions): HttpServer {
  const server = http.createServer((req, res) => handle(req, res, opts.daemon));
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.bindHost, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      log.info({ port: boundPort, host: opts.bindHost }, 'http listening');
      return { port: boundPort };
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function handle(req: IncomingMessage, res: ServerResponse, daemon: Daemon): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  if (url.pathname === '/api/v1/state') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return sendJson(res, 200, snapshotDaemon(daemon));
  }
  if (url.pathname === '/api/v1/refresh') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    daemon.triggerRefresh();
    return sendJson(res, 202, {
      queued: true,
      coalesced: false,
      requested_at: new Date().toISOString(),
      operations: ['poll', 'reconcile'],
      profiles: daemon.getRuntimes().map((r) => r.profile.name),
    });
  }
  const issueMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
  if (issueMatch) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const id = decodeURIComponent(issueMatch[1]!);
    const detail = snapshotIssueAcrossDaemon(daemon, id);
    if (!detail) {
      return sendJson(res, 404, {
        error: {
          code: 'issue_not_found',
          message: `No running or pending issue with identifier ${id}`,
        },
      });
    }
    return sendJson(res, 200, detail);
  }
  return sendJson(res, 404, {
    error: { code: 'not_found', message: `No such route: ${url.pathname}` },
  });
}

function methodNotAllowed(res: ServerResponse, allow: string[]): void {
  res.statusCode = 405;
  res.setHeader('Allow', allow.join(', '));
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      error: { code: 'method_not_allowed', message: `Allowed: ${allow.join(', ')}` },
    }),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

interface RunningRow {
  client: string;
  issue_id: string;
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
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export function snapshotDaemon(daemon: Daemon) {
  const now = Date.now();
  const running: RunningRow[] = [];
  const retrying: RetryRow[] = [];
  const totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, ended_session_seconds: 0 };
  const profiles = daemon.getRuntimes().map((rt) => {
    const state = rt.orchestrator.getState();
    for (const e of state.running.values()) running.push(formatRunning(rt.profile.name, e));
    for (const r of state.retry_attempts.values()) retrying.push(formatRetry(rt.profile.name, r));
    totals.input_tokens += state.totals.input_tokens + sumActiveTokens(state.running, 'input');
    totals.output_tokens += state.totals.output_tokens + sumActiveTokens(state.running, 'output');
    totals.total_tokens += state.totals.total_tokens + sumActiveTokens(state.running, 'total');
    totals.ended_session_seconds += state.totals.ended_session_seconds + sumActiveSeconds(state.running, now);
    return profileSummary(rt, state, now);
  });
  return {
    generated_at: new Date(now).toISOString(),
    counts: { running: running.length, retrying: retrying.length, profiles: profiles.length },
    running,
    retrying,
    profiles,
    claude_totals: {
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      total_tokens: totals.total_tokens,
      seconds_running: totals.ended_session_seconds,
    },
  };
}

function snapshotIssueAcrossDaemon(daemon: Daemon, identifier: string) {
  for (const rt of daemon.getRuntimes()) {
    const detail = snapshotIssueOne(rt, identifier);
    if (detail) return detail;
  }
  return null;
}

function snapshotIssueOne(rt: ProfileRuntime, identifier: string) {
  const state = rt.orchestrator.getState();
  const runningEntry =
    [...state.running.values()].find(
      (e) => e.identifier === identifier || e.issue_id === identifier,
    ) ?? null;
  const retryEntry =
    [...state.retry_attempts.values()].find(
      (e) => e.identifier === identifier || e.issue_id === identifier,
    ) ?? null;
  if (!runningEntry && !retryEntry) return null;
  return {
    client: rt.profile.name,
    issue_identifier: runningEntry?.identifier ?? retryEntry?.identifier ?? identifier,
    issue_id: runningEntry?.issue_id ?? retryEntry?.issue_id ?? identifier,
    status: runningEntry ? 'running' : 'retrying',
    workspace: runningEntry ? { path: null } : null,
    running: runningEntry ? formatRunning(rt.profile.name, runningEntry) : null,
    retry: retryEntry ? formatRetry(rt.profile.name, retryEntry) : null,
    last_error: retryEntry?.error ?? null,
  };
}

function profileSummary(rt: ProfileRuntime, state: OrchestratorState, now: number) {
  return {
    name: rt.profile.name,
    tracker_kind: rt.profile.config.tracker.kind,
    team_key: rt.profile.config.tracker.team_key,
    project_slug: rt.profile.config.tracker.project_slug,
    workspace_root: rt.profile.config.workspace.root,
    counts: {
      running: state.running.size,
      retrying: state.retry_attempts.size,
      completed_total: state.completed.size,
    },
    seconds_running:
      state.totals.ended_session_seconds + sumActiveSeconds(state.running, now),
    guardrails: {
      max_turns: rt.profile.config.agent.max_turns,
      max_retry_attempts: rt.profile.config.agent.max_retry_attempts,
      max_total_tokens_per_daemon: rt.profile.config.agent.max_total_tokens_per_daemon,
    },
  };
}

function formatRunning(client: string, entry: RunningEntry): RunningRow {
  return {
    client,
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    state: entry.issue.state,
    session_id: entry.session_id,
    turn_count: entry.turn_count,
    last_event: entry.last_event,
    last_event_at: entry.last_event_at ? new Date(entry.last_event_at).toISOString() : null,
    started_at: new Date(entry.started_at).toISOString(),
    tokens: {
      input_tokens: entry.claude_input_tokens,
      output_tokens: entry.claude_output_tokens,
      total_tokens: entry.claude_total_tokens,
    },
  };
}

function formatRetry(client: string, entry: RetryEntry): RetryRow {
  return {
    client,
    issue_id: entry.issue_id,
    issue_identifier: entry.identifier,
    attempt: entry.attempt,
    due_at: new Date(entry.due_at_ms).toISOString(),
    error: entry.error,
  };
}

function sumActiveSeconds(running: Map<string, RunningEntry>, now: number): number {
  let s = 0;
  for (const e of running.values()) s += Math.max(0, (now - e.started_at) / 1000);
  return s;
}

function sumActiveTokens(
  running: Map<string, RunningEntry>,
  kind: 'input' | 'output' | 'total',
): number {
  let s = 0;
  for (const e of running.values()) {
    if (kind === 'input') s += e.claude_input_tokens;
    else if (kind === 'output') s += e.claude_output_tokens;
    else s += e.claude_total_tokens;
  }
  return s;
}

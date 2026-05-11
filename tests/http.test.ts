import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon, type ProfileRuntime } from '../src/daemon.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { WorkerExit } from '../src/orchestrator/state.js';
import type { WorkerArgs } from '../src/orchestrator/worker.js';
import { createHttpServer } from '../src/server/http.js';
import { buildServiceConfig } from '../src/workflow/config.js';
import type { Issue, ServiceConfig } from '../src/workflow/types.js';
import type { TrackerClient, TrackerResult, MinimalIssueState } from '../src/tracker/types.js';
import { WorkspaceManager } from '../src/workspace/manager.js';

class StaticTracker implements TrackerClient {
  constructor(private candidates: Issue[]) {}
  async fetch_candidate_issues(): Promise<TrackerResult<Issue[]>> {
    return { ok: true, value: this.candidates };
  }
  async fetch_issues_by_states(): Promise<TrackerResult<Array<Pick<Issue, 'id' | 'identifier'>>>> {
    return { ok: true, value: [] };
  }
  async fetch_issue_states_by_ids(): Promise<TrackerResult<MinimalIssueState[]>> {
    return { ok: true, value: [] };
  }
}

function makeIssue(): Issue {
  return {
    id: 'uuid-1',
    identifier: 'MS-101',
    title: 'do thing',
    description: null,
    priority: 1,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: null,
  };
}

function makeConfig(): ServiceConfig {
  process.env.LINEAR_API_KEY = 'k';
  return buildServiceConfig(
    {
      config: {
        tracker: { kind: 'linear', project_slug: 'market-savvy' },
        agent: { max_concurrent_agents: 2, max_turns: 1 },
      },
      prompt_template: 'p',
    },
    '/x/WORKFLOW.md',
  );
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-http-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, init);
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

describe('HTTP /api/v1/*', () => {
  it('GET /api/v1/state returns counts and running list', async () => {
    const config = { ...makeConfig(), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new StaticTracker([issue]);
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    let resolveWorker: ((v: WorkerExit) => void) | null = null;
    const workerFn = vi.fn(
      (_args: WorkerArgs) =>
        new Promise<WorkerExit>((res) => {
          resolveWorker = res;
        }),
    );
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });
    await orch.tick();

    const runtime: ProfileRuntime = {
      profile: { name: 'test-client', path: '/x/WORKFLOW.md', config },
      tracker,
      workspace,
      orchestrator: orch,
      watcher: { stop: () => {} },
    };
    const daemon = Daemon.fromRuntimes([runtime]);
    const server = createHttpServer({ port: 0, bindHost: '127.0.0.1', daemon });
    const { port } = await server.listen();

    const state = await fetchJson(`http://127.0.0.1:${port}/api/v1/state`);
    expect(state.status).toBe(200);
    const body = state.body as { counts: { running: number }; running: Array<{ issue_identifier: string }> };
    expect(body.counts.running).toBe(1);
    expect(body.running[0]?.issue_identifier).toBe('MS-101');

    const detail = await fetchJson(`http://127.0.0.1:${port}/api/v1/MS-101`);
    expect(detail.status).toBe(200);
    const detailBody = detail.body as { status: string };
    expect(detailBody.status).toBe('running');

    const missing = await fetchJson(`http://127.0.0.1:${port}/api/v1/UNKNOWN-1`);
    expect(missing.status).toBe(404);

    const wrongMethod = await fetchJson(`http://127.0.0.1:${port}/api/v1/state`, {
      method: 'POST',
    });
    expect(wrongMethod.status).toBe(405);

    const refresh = await fetchJson(`http://127.0.0.1:${port}/api/v1/refresh`, {
      method: 'POST',
    });
    expect(refresh.status).toBe(202);

    resolveWorker!({ kind: 'normal', turns: 1 });
    await server.close();
    await orch.shutdown();
  });
});

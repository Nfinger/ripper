import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { WorkerExit } from '../src/orchestrator/state.js';
import type { WorkerArgs } from '../src/orchestrator/worker.js';
import { buildServiceConfig } from '../src/workflow/config.js';
import type { Issue, ServiceConfig } from '../src/workflow/types.js';
import type { TrackerClient, MinimalIssueState, TrackerResult } from '../src/tracker/types.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
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
    ...overrides,
  };
}

class FakeTracker implements TrackerClient {
  candidates: Issue[][];
  states: MinimalIssueState[][];
  terminal: Array<Pick<Issue, 'id' | 'identifier'>>;
  stateUpdates: Array<{ issueId: string; stateName: string }> = [];
  candidateCalls = 0;
  stateRefreshCalls = 0;

  constructor(opts: {
    candidates?: Issue[][];
    states?: MinimalIssueState[][];
    terminal?: Array<Pick<Issue, 'id' | 'identifier'>>;
  }) {
    this.candidates = opts.candidates ?? [];
    this.states = opts.states ?? [];
    this.terminal = opts.terminal ?? [];
  }

  async fetch_candidate_issues(): Promise<TrackerResult<Issue[]>> {
    const idx = Math.min(this.candidateCalls, this.candidates.length - 1);
    this.candidateCalls += 1;
    return { ok: true, value: idx >= 0 ? this.candidates[idx] ?? [] : [] };
  }
  async fetch_issues_by_states(): Promise<TrackerResult<Array<Pick<Issue, 'id' | 'identifier'>>>> {
    return { ok: true, value: this.terminal };
  }
  async fetch_issue_states_by_ids(): Promise<TrackerResult<MinimalIssueState[]>> {
    const idx = Math.min(this.stateRefreshCalls, this.states.length - 1);
    this.stateRefreshCalls += 1;
    return { ok: true, value: idx >= 0 ? this.states[idx] ?? [] : [] };
  }
  async update_issue_state(issueId: string, stateName: string): Promise<TrackerResult<{ state: string }>> {
    this.stateUpdates.push({ issueId, stateName });
    return { ok: true, value: { state: stateName } };
  }
}

function makeConfig(agentOverrides: Record<string, unknown> = {}): ServiceConfig {
  process.env.LINEAR_API_KEY='***';
  return buildServiceConfig(
    {
      config: {
        tracker: { kind: 'linear', project_slug: 'market-savvy' },
        polling: { interval_ms: 60_000 },
        agent: {
          max_concurrent_agents: 2,
          max_turns: 1,
          max_retry_backoff_ms: 600_000,
          ...agentOverrides,
        },
      },
      prompt_template: 'Work on {{ issue.identifier }}.',
    },
    '/x/WORKFLOW.md',
  );
}

function withLifecycle(config: ServiceConfig): ServiceConfig {
  return {
    ...config,
    tracker: {
      ...config.tracker,
      active_states: ['Todo'],
      lifecycle: {
        claim_state: 'In Progress',
        success_state: 'Ready for Review',
        failure_state: 'Agent Failed',
      },
    },
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-orch-'));
  vi.useFakeTimers({ shouldAdvanceTime: true });

});

afterEach(async () => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Orchestrator', () => {
  it('dispatches an eligible issue once and does not schedule continuation retries after normal exit', async () => {
    const config = { ...makeConfig(), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({
      candidates: [[issue], [issue], [issue]],
      states: [[]],
    });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const calls: WorkerArgs[] = [];
    const workerFn = vi.fn(async (args: WorkerArgs): Promise<WorkerExit> => {
      calls.push(args);
      return { kind: 'normal', turns: 1 };
    });
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();
    expect(workerFn).toHaveBeenCalledTimes(1);
    expect(calls[0]?.issue.identifier).toBe('MS-101');

    await Promise.resolve();
    await Promise.resolve();
    expect(orch.getState().running.size).toBe(0);
    expect(orch.getState().completed.has('uuid-1')).toBe(true);
    expect(orch.getState().retry_attempts.has('uuid-1')).toBe(false);

    await orch.tick();
    expect(workerFn).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });

  it('schedules exponential backoff retry on failed worker exit', async () => {
    const config = { ...makeConfig(), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({ candidates: [[issue]] });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const workerFn = vi.fn(async (): Promise<WorkerExit> => ({
      kind: 'failed',
      reason: 'oops',
      turns: 1,
    }));
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();
    await Promise.resolve();
    await Promise.resolve();
    const retry = orch.getState().retry_attempts.get('uuid-1');
    expect(retry).toBeDefined();
    expect(retry?.error).toBe('oops');
    // First failure, attempt=1 → 10s backoff (per spec §8.4)
    expect(retry!.due_at_ms - Date.now()).toBeGreaterThanOrEqual(9_000);
    await orch.shutdown();
  });

  it('does not redispatch the same issue while it is still claimed', async () => {
    const config = { ...makeConfig(), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({
      candidates: [[issue], [issue], [issue]],
      states: [[{ id: issue.id, identifier: issue.identifier, state: 'Todo' }]],
    });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    let resolveWorker: ((v: WorkerExit) => void) | null = null;
    const workerFn = vi.fn(
      () =>
        new Promise<WorkerExit>((res) => {
          resolveWorker = res;
        }),
    );
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();
    await orch.tick();
    expect(workerFn).toHaveBeenCalledTimes(1);
    resolveWorker!({ kind: 'normal', turns: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await orch.shutdown();
  });

  it('cancels worker when reconcile observes terminal state and removes workspace', async () => {
    const config = { ...makeConfig(), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({
      candidates: [[issue]],
      states: [[{ id: issue.id, identifier: issue.identifier, state: 'Done' }]],
    });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    let signalRef: AbortSignal | null = null;
    const workerFn = vi.fn(
      (args: WorkerArgs) =>
        new Promise<WorkerExit>((res) => {
          signalRef = args.signal;
          args.signal.addEventListener('abort', () =>
            res({ kind: 'cancelled', reason: 'aborted' }),
          );
        }),
    );
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick(); // dispatch
    fs.mkdirSync(path.join(tmp, 'MS-101'), { recursive: true });
    await orch.reconcileRunningIssues();
    expect(signalRef?.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.existsSync(path.join(tmp, 'MS-101'))).toBe(false);
    await orch.shutdown();
  });

  it('keeps claimed lifecycle state running during reconcile without making it a candidate state', async () => {
    const config = withLifecycle({ ...makeConfig(), workspace: { root: tmp } });
    expect(config.tracker.active_states).toEqual(['Todo']);
    const issue = makeIssue();
    const tracker = new FakeTracker({
      candidates: [[issue]],
      states: [[{ id: issue.id, identifier: issue.identifier, state: 'In Progress' }]],
    });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    let signalRef: AbortSignal | null = null;
    let resolveWorker: ((v: WorkerExit) => void) | null = null;
    const workerFn = vi.fn(
      (args: WorkerArgs) =>
        new Promise<WorkerExit>((res) => {
          signalRef = args.signal;
          resolveWorker = res;
        }),
    );
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();
    await orch.reconcileRunningIssues();

    expect(signalRef?.aborted).toBe(false);
    expect(orch.getState().running.has(issue.id)).toBe(true);
    resolveWorker!({ kind: 'normal', turns: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await orch.shutdown();
  });

  it('suppresses retries after max_retry_attempts is reached', async () => {
    const config = { ...makeConfig({ max_retry_attempts: 0 }), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({ candidates: [[issue], [issue]] });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const workerFn = vi.fn(async (): Promise<WorkerExit> => ({
      kind: 'failed',
      reason: 'repeat failure',
      turns: 1,
    }));
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(orch.getState().retry_attempts.has(issue.id)).toBe(false);
    expect(orch.getState().completed.has(issue.id)).toBe(true);
    await orch.tick();
    expect(workerFn).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });

  it('skips new dispatches once the daemon token budget is exhausted', async () => {
    const config = { ...makeConfig({ max_total_tokens_per_daemon: 100 }), workspace: { root: tmp } };
    const issue = makeIssue();
    const tracker = new FakeTracker({ candidates: [[issue]] });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const workerFn = vi.fn(async (): Promise<WorkerExit> => ({ kind: 'normal', turns: 1 }));
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });
    orch.getState().totals.total_tokens = 100;

    await orch.tick();

    expect(workerFn).not.toHaveBeenCalled();
    await orch.shutdown();
  });

  it('moves an issue to the configured claim state before starting the worker', async () => {
    const config = withLifecycle({ ...makeConfig(), workspace: { root: tmp } });
    const issue = makeIssue();
    const tracker = new FakeTracker({ candidates: [[issue]] });
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const workerFn = vi.fn(async (): Promise<WorkerExit> => ({ kind: 'normal', turns: 1 }));
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();

    expect(tracker.stateUpdates[0]).toEqual({ issueId: issue.id, stateName: 'In Progress' });
    expect(workerFn).toHaveBeenCalledTimes(1);
    await orch.shutdown();
  });

  it('does not start the worker when a configured claim transition fails', async () => {
    const config = withLifecycle({ ...makeConfig(), workspace: { root: tmp } });
    const issue = makeIssue();
    const tracker = new FakeTracker({ candidates: [[issue]] });
    tracker.update_issue_state = vi.fn(async () => ({
      ok: false,
      error: { code: 'linear_unknown_payload', message: 'state missing' },
    }));
    const workspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: config.hooks });
    const workerFn = vi.fn(async (): Promise<WorkerExit> => ({ kind: 'normal', turns: 1 }));
    const orch = new Orchestrator({ config, tracker, workspace, workerFn });

    await orch.tick();

    expect(workerFn).not.toHaveBeenCalled();
    expect(orch.getState().claimed.has(issue.id)).toBe(false);
    await orch.shutdown();
  });

  it('moves an issue to success or failure lifecycle states after final worker exit', async () => {
    const successConfig = withLifecycle({ ...makeConfig(), workspace: { root: tmp } });
    const issue = makeIssue();
    const successTracker = new FakeTracker({ candidates: [[issue]] });
    const successWorkspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: successConfig.hooks });
    const successOrch = new Orchestrator({
      config: successConfig,
      tracker: successTracker,
      workspace: successWorkspace,
      workerFn: vi.fn(async (): Promise<WorkerExit> => ({ kind: 'normal', turns: 1 })),
    });

    await successOrch.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(successTracker.stateUpdates.map((u) => u.stateName)).toEqual(['In Progress', 'Ready for Review']);
    await successOrch.shutdown();

    const failureConfig = withLifecycle({ ...makeConfig({ max_retry_attempts: 0 }), workspace: { root: tmp } });
    const failureTracker = new FakeTracker({ candidates: [[issue]] });
    const failureWorkspace = new WorkspaceManager({ workspaceRoot: tmp, hooks: failureConfig.hooks });
    const failureOrch = new Orchestrator({
      config: failureConfig,
      tracker: failureTracker,
      workspace: failureWorkspace,
      workerFn: vi.fn(async (): Promise<WorkerExit> => ({ kind: 'failed', reason: 'boom', turns: 1 })),
    });

    await failureOrch.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(failureTracker.stateUpdates.map((u) => u.stateName)).toEqual(['In Progress', 'Agent Failed']);
    await failureOrch.shutdown();
  });
});




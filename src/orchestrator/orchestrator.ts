import { log } from '../log.js';
import type { AgentEvent, TurnResult } from '../agent/types.js';
import type { Issue, ServiceConfig } from '../workflow/types.js';
import type { TrackerClient } from '../tracker/types.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import {
  computeAvailableSlots,
  computeBackoffMs,
  isEligible,
  sortForDispatch,
} from './selection.js';
import {
  applyTokenDelta,
  createInitialState,
  rollupTotalsForExit,
  type OrchestratorState,
  type RunningEntry,
  type WorkerExit,
} from './state.js';
import { runIssueWorker, type WorkerArgs } from './worker.js';

export type WorkerFn = (args: WorkerArgs) => Promise<WorkerExit>;

export interface OrchestratorOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  workspace: WorkspaceManager;
  onObserve?: (state: OrchestratorState) => void;
  workerFn?: WorkerFn;
}

export class Orchestrator {
  private readonly state: OrchestratorState;
  private config: ServiceConfig;
  private readonly tracker: TrackerClient;
  private readonly workspace: WorkspaceManager;
  private readonly onObserve: ((state: OrchestratorState) => void) | undefined;
  private readonly workerFn: WorkerFn;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(opts: OrchestratorOptions) {
    this.config = opts.config;
    this.tracker = opts.tracker;
    this.workspace = opts.workspace;
    this.onObserve = opts.onObserve ?? undefined;
    this.workerFn = opts.workerFn ?? runIssueWorker;
    this.state = createInitialState({
      poll_interval_ms: opts.config.polling.interval_ms,
      max_concurrent_agents: opts.config.agent.max_concurrent_agents,
    });
  }

  /** Public read-only state snapshot for observability. */
  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Re-apply config changes per spec §6.2. Polling cadence and concurrency
   * are picked up immediately for future ticks/dispatches; in-flight workers
   * keep running with the config they started with.
   */
  applyConfig(next: ServiceConfig): void {
    this.config = next;
    this.state.poll_interval_ms = next.polling.interval_ms;
    this.state.max_concurrent_agents = next.agent.max_concurrent_agents;
  }

  async startupCleanup(): Promise<void> {
    const res = await this.tracker.fetch_issues_by_states(this.config.tracker.terminal_states);
    if (!res.ok) {
      log.warn({ err: res.error }, 'startup terminal cleanup failed (continuing)');
      return;
    }
    for (const issue of res.value) {
      const removed = await this.workspace.removeForIssue(issue.identifier);
      if (!removed.ok) {
        log.warn(
          { identifier: issue.identifier, err: removed.error },
          'startup terminal workspace cleanup failed for issue',
        );
      }
    }
  }

  scheduleTick(delayMs: number): void {
    if (this.stopping) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /**
   * One poll-and-dispatch cycle. Spec §16.2.
   */
  async tick(): Promise<void> {
    try {
      await this.reconcileRunningIssues();
      const candidatesRes = await this.tracker.fetch_candidate_issues();
      if (!candidatesRes.ok) {
        log.warn({ err: candidatesRes.error }, 'candidate fetch failed (skipping dispatch)');
        return;
      }
      const sorted = sortForDispatch(candidatesRes.value);
      let slots = computeAvailableSlots(this.state, this.config);
      for (const issue of sorted) {
        if (slots.global_available <= 0) break;
        if (this.isTokenBudgetExhausted()) {
          log.warn(
            {
              total_tokens: this.currentTotalTokens(),
              max_total_tokens_per_daemon: this.config.agent.max_total_tokens_per_daemon,
            },
            'token budget exhausted; skipping dispatch',
          );
          break;
        }
        if (!isEligible(issue, this.state, this.config, slots)) continue;
        this.dispatchIssue(issue, null);
        slots = computeAvailableSlots(this.state, this.config);
      }
      this.notifyObservers();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'tick threw');
    } finally {
      this.scheduleTick(this.state.poll_interval_ms);
    }
  }

  private notifyObservers(): void {
    if (this.onObserve) {
      try {
        this.onObserve(this.state);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'observer threw');
      }
    }
  }

  /**
   * Spec §16.4 — claim, spawn worker, install lifecycle handlers.
   */
  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();
    const startedAt = Date.now();
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      worker_promise: Promise.resolve({ kind: 'normal', turns: 0 }),
      abort,
      retry_attempt: attempt,
      started_at: startedAt,
      turn_count: 0,
      thread_id: null,
      session_id: null,
      claude_pid: null,
      last_event: null,
      last_event_at: null,
      last_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
    };

    const promise = this.workerFn({
      issue,
      attempt,
      workspace: this.workspace,
      tracker: this.tracker,
      promptTemplate: this.config.prompt_template,
      config: this.config,
      signal: abort.signal,
      callbacks: {
        onAgentEvent: (issueId, event) => this.handleAgentEvent(issueId, event),
        onTurnFinished: (issueId, turnNumber, result) =>
          this.handleTurnFinished(issueId, turnNumber, result),
      },
    });

    entry.worker_promise = promise;
    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);

    promise
      .then((exit) => this.handleWorkerExit(issue.id, exit))
      .catch((err) => {
        log.error(
          { issue_id: issue.id, err: (err as Error).message },
          'worker promise rejected unexpectedly',
        );
        this.handleWorkerExit(issue.id, {
          kind: 'failed',
          reason: `worker threw: ${(err as Error).message}`,
          turns: 0,
        });
      });
  }

  private handleAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    entry.last_event = event.event;
    entry.last_event_at = Date.now();
    if (event.event === 'session_started') {
      entry.thread_id = event.thread_id;
      entry.session_id = `${event.thread_id}-${event.turn_id}`;
      entry.claude_pid = event.pid;
    }
    if (event.event === 'turn_message') {
      entry.last_message = event.raw;
    }
    if (event.event === 'turn_completed') {
      if (event.usage) applyTokenDelta(entry, event.usage);
      this.abortIfTokenBudgetExceeded(entry);
    }
  }

  private handleTurnFinished(issueId: string, turnNumber: number, result: TurnResult): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    entry.turn_count = turnNumber;
    if (result.thread_id) entry.thread_id = result.thread_id;
    entry.session_id = `${result.thread_id ?? 'unknown'}-${result.turn_id}`;
    if (result.usage) applyTokenDelta(entry, result.usage);
    this.abortIfTokenBudgetExceeded(entry);
  }

  private handleWorkerExit(issueId: string, exit: WorkerExit): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    this.state.running.delete(issueId);
    rollupTotalsForExit(this.state, entry, Date.now());

    if (exit.kind === 'normal') {
      this.state.completed.add(issueId);
      return;
    }
    if (exit.kind === 'cancelled') {
      // reconciliation already decided what to do with this claim.
      this.state.claimed.delete(issueId);
      return;
    }
    const nextAttempt = (entry.retry_attempt ?? 0) + 1;
    if (nextAttempt > this.config.agent.max_retry_attempts) {
      this.state.claimed.delete(issueId);
      this.state.completed.add(issueId);
      log.warn(
        {
          issue_id: issueId,
          identifier: entry.identifier,
          attempts: nextAttempt - 1,
          reason: exit.reason,
        },
        'max retry attempts reached; suppressing issue for this daemon run',
      );
      return;
    }
    const delay = computeBackoffMs(nextAttempt, this.config.agent.max_retry_backoff_ms);
    this.scheduleRetry(entry, nextAttempt, exit.reason, delay);
  }

  private currentTotalTokens(): number {
    let active = 0;
    for (const entry of this.state.running.values()) active += entry.claude_total_tokens;
    return this.state.totals.total_tokens + active;
  }

  private isTokenBudgetExhausted(): boolean {
    const max = this.config.agent.max_total_tokens_per_daemon;
    return max > 0 && this.currentTotalTokens() >= max;
  }

  private abortIfTokenBudgetExceeded(entry: RunningEntry): void {
    if (!this.isTokenBudgetExhausted()) return;
    const total = this.currentTotalTokens();
    const max = this.config.agent.max_total_tokens_per_daemon;
    log.error(
      { issue_id: entry.issue_id, identifier: entry.identifier, total_tokens: total, max_total_tokens_per_daemon: max },
      'token budget exceeded; aborting worker',
    );
    entry.abort.abort(`token budget exceeded: ${total}/${max}`);
  }

  private scheduleRetry(
    entry: RunningEntry,
    attempt: number,
    error: string | null,
    delayMs: number,
  ): void {
    const existing = this.state.retry_attempts.get(entry.issue_id);
    if (existing) clearTimeout(existing.timer_handle);
    const dueAt = Date.now() + delayMs;
    const handle = setTimeout(() => {
      void this.handleRetryTimer(entry.issue_id);
    }, delayMs);
    this.state.retry_attempts.set(entry.issue_id, {
      issue_id: entry.issue_id,
      identifier: entry.identifier,
      attempt,
      due_at_ms: dueAt,
      timer_handle: handle,
      error,
    });
  }

  private async handleRetryTimer(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);

    const candidates = await this.tracker.fetch_candidate_issues();
    if (!candidates.ok) {
      const next = retry.attempt + 1;
      const delay = computeBackoffMs(next, this.config.agent.max_retry_backoff_ms);
      this.scheduleRetry(
        {
          ...syntheticRunningForRetry(retry.issue_id, retry.identifier),
        },
        next,
        `retry poll failed: ${candidates.error.code}`,
        delay,
      );
      return;
    }
    const issue = candidates.value.find((i) => i.id === issueId);
    if (!issue) {
      this.state.claimed.delete(issueId);
      return;
    }
    const slots = computeAvailableSlots(this.state, this.config);
    if (!isEligible(issue, this.state, this.config, slots)) {
      // not eligible right now — could be no slot, blocker, or non-active.
      // requeue with same attempt + 1 if no slots; otherwise release.
      if (slots.global_available <= 0) {
        const delay = computeBackoffMs(retry.attempt + 1, this.config.agent.max_retry_backoff_ms);
        this.scheduleRetry(
          syntheticRunningForRetry(issueId, issue.identifier),
          retry.attempt + 1,
          'no available orchestrator slots',
          delay,
        );
      } else {
        this.state.claimed.delete(issueId);
      }
      return;
    }
    this.dispatchIssue(issue, retry.attempt);
  }

  /**
   * Spec §16.3 — stall detection + tracker state refresh on running issues.
   */
  async reconcileRunningIssues(): Promise<void> {
    this.detectStalls();
    if (this.state.running.size === 0) return;
    const ids = [...this.state.running.keys()];
    const refreshed = await this.tracker.fetch_issue_states_by_ids(ids);
    if (!refreshed.ok) {
      log.warn({ err: refreshed.error }, 'state refresh failed (keeping workers)');
      return;
    }
    const terminalSet = new Set(this.config.tracker.terminal_states.map((s) => s.toLowerCase()));
    const activeSet = new Set(this.config.tracker.active_states.map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    for (const item of refreshed.value) {
      seen.add(item.id);
      const entry = this.state.running.get(item.id);
      if (!entry) continue;
      const stateLower = item.state.toLowerCase();
      if (terminalSet.has(stateLower)) {
        entry.abort.abort('issue transitioned to terminal state');
        await this.workspace.removeForIssue(entry.identifier);
        continue;
      }
      if (activeSet.has(stateLower)) {
        entry.issue = { ...entry.issue, state: item.state };
      } else {
        entry.abort.abort(`issue transitioned to non-active state ${item.state}`);
      }
    }
    // Anything not seen — leave as-is; tracker may have hidden it temporarily.
    void seen;
  }

  private detectStalls(): void {
    const stallMs = this.config.claude.stall_timeout_ms;
    if (stallMs <= 0) return;
    const now = Date.now();
    for (const entry of this.state.running.values()) {
      const last = entry.last_event_at ?? entry.started_at;
      if (now - last > stallMs) {
        entry.abort.abort(`stall: no activity in ${now - last}ms`);
      }
    }
  }

  /**
   * Cancel everything. Caller should await to drain in-flight workers.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    for (const retry of this.state.retry_attempts.values()) {
      clearTimeout(retry.timer_handle);
    }
    this.state.retry_attempts.clear();
    const drains: Array<Promise<unknown>> = [];
    for (const entry of this.state.running.values()) {
      entry.abort.abort('shutdown');
      drains.push(entry.worker_promise.catch(() => {}));
    }
    await Promise.all(drains);
  }
}

function syntheticRunningForRetry(issueId: string, identifier: string): RunningEntry {
  return {
    issue_id: issueId,
    identifier,
    issue: {
      id: issueId,
      identifier,
      title: identifier,
      description: null,
      priority: null,
      state: '',
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    },
    worker_promise: Promise.resolve({ kind: 'normal', turns: 0 }),
    abort: new AbortController(),
    retry_attempt: null,
    started_at: 0,
    turn_count: 0,
    thread_id: null,
    session_id: null,
    claude_pid: null,
    last_event: null,
    last_event_at: null,
    last_message: null,
    claude_input_tokens: 0,
    claude_output_tokens: 0,
    claude_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
  };
}

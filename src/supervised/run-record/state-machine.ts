import { randomUUID } from 'node:crypto';
import { appendEvent, appendIndexEntry, readRunById, runDirForId, updateRunJson } from './store.js';
import type { RunReason, RunStatus } from './types.js';

const ALLOWED_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  initialized: ['refused', 'preflight_running', 'dry_run'],
  preflight_running: ['preflight_failed', 'candidate_selected'],
  candidate_selected: ['refused', 'claimed'],
  claimed: ['codex_running', 'failed', 'cancelled'],
  codex_running: ['codex_completed', 'failed', 'timed_out', 'cancelled'],
  codex_completed: ['validation_running', 'failed'],
  validation_running: ['validation_completed', 'failed', 'timed_out'],
  validation_completed: ['handoff_running', 'failed'],
  handoff_running: ['pr_created', 'ci_running', 'failed', 'succeeded_with_warnings'],
  pr_created: ['ci_running', 'failed'],
  ci_running: ['ci_completed', 'succeeded', 'succeeded_with_warnings', 'failed', 'timed_out'],
  ci_completed: ['succeeded', 'failed'],
  succeeded: [],
  succeeded_with_warnings: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  refused: [],
  preflight_failed: [],
  dry_run: [],
};

export class TransitionError extends Error {
  readonly code = 'invalid_run_transition';

  constructor(readonly from: RunStatus, readonly to: RunStatus) {
    super(`Invalid run transition: ${from} -> ${to}`);
    this.name = 'TransitionError';
  }
}

export interface TransitionStore {
  homeDir: string;
}

export function assertTransitionAllowed(from: RunStatus, to: RunStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new TransitionError(from, to);
  }
}

export async function transitionRun(store: TransitionStore, runId: string, to: RunStatus, reason: RunReason | null = null, now = new Date()): Promise<void> {
  const run = await readRunById(store.homeDir, runId);
  const canonicalRunDir = runDirForId(store.homeDir, runId);
  if (run.run_dir !== canonicalRunDir) {
    throw new Error(`Run directory mismatch for ${runId}`);
  }
  const from = run.status;
  assertTransitionAllowed(from, to);

  const timestamp = now.toISOString();
  const updated = { ...run, status: to, reason, updated_at: timestamp };
  await updateRunJson(run.run_dir, updated);
  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: runId,
    timestamp,
    type: 'transition',
    data: { from, to, reason },
  });
  await appendIndexEntry(store.homeDir, updated);
}

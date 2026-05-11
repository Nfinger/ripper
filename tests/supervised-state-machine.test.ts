import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunRecord } from '../src/supervised/run-record/store.js';
import { assertTransitionAllowed, transitionRun, TransitionError } from '../src/supervised/run-record/state-machine.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-state-machine-'));
}

describe('run state machine', () => {
  it('allows initialized -> preflight_running', () => {
    expect(() => assertTransitionAllowed('initialized', 'preflight_running')).not.toThrow();
  });

  it('allows claimed -> codex_running', () => {
    expect(() => assertTransitionAllowed('claimed', 'codex_running')).not.toThrow();
  });

  it('rejects preflight_failed -> handoff_running', () => {
    expect(() => assertTransitionAllowed('preflight_failed', 'handoff_running')).toThrow(TransitionError);
  });

  it('allows review remediation loop transitions', () => {
    expect(() => assertTransitionAllowed('code_review_running', 'review_remediation_running')).not.toThrow();
    expect(() => assertTransitionAllowed('review_remediation_running', 'review_remediation_completed')).not.toThrow();
    expect(() => assertTransitionAllowed('review_remediation_completed', 'code_review_running')).not.toThrow();
  });

  it('transitionRun writes a transition event and updates run.json', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-1', profileName: 'default', profileHash: 'abc123', issueKey: 'ENG-123', mutating: true, now: new Date('2026-05-10T07:45:09.123Z') });

    await transitionRun({ homeDir }, 'run-1', 'preflight_running', null, new Date('2026-05-10T07:46:00.000Z'));

    const parsedRun = JSON.parse(await readFile(join(run.run_dir, 'run.json'), 'utf8')) as { status: string; updated_at: string };
    const eventLines = (await readFile(join(run.run_dir, 'events.jsonl'), 'utf8')).trim().split('\n');
    const transition = JSON.parse(eventLines[1]) as { type: string; data: { from: string; to: string } };

    expect(parsedRun.status).toBe('preflight_running');
    expect(parsedRun.updated_at).toBe('2026-05-10T07:46:00.000Z');
    expect(transition.type).toBe('transition');
    expect(transition.data).toEqual({ from: 'initialized', to: 'preflight_running', reason: null });
  });
});

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAdapter, type CodexFailureReason, type CodexRunOptions, type CodexRunResult } from '../adapters/codex.js';
import { GitAdapter } from '../adapters/git.js';
import type { SupervisedProfile } from '../profile/types.js';
import { appendEvent, readRunById } from '../run-record/store.js';
import { transitionRun } from '../run-record/state-machine.js';
import type { ArtifactsManifest, RunArtifact, RunReason } from '../run-record/types.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';

export interface CodexPhaseGitClient {
  createWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void>;
  protectWorktreeFromAgentPush?(worktreePath: string, remote: string): Promise<void>;
}

export interface CodexPhaseCodexClient {
  run(opts: CodexRunOptions): Promise<CodexRunResult>;
}

export interface RunCodexPhaseOptions {
  homeDir: string;
  runId: string;
  profile: SupervisedProfile;
  prompt: string;
  branch: string;
  baseRef: string;
  git?: CodexPhaseGitClient;
  codex?: CodexPhaseCodexClient;
  now?: Date;
}

export type RunCodexPhaseResult = { ok: true; worktreePath: string } | { ok: false; reason: RunReason };

export async function runCodexPhase(opts: RunCodexPhaseOptions): Promise<RunCodexPhaseResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  const git = opts.git ?? new GitAdapter();
  const codex = opts.codex ?? new CodexAdapter();
  const now = opts.now ?? new Date();
  const worktreePath = path.join(opts.homeDir, '.symphony', 'worktrees', opts.runId);
  const promptArtifactPath = path.join(run.run_dir, 'prompt.md');
  const rawLogPath = path.join(run.run_dir, 'codex.log');
  const redactedLogPath = path.join(run.run_dir, 'codex.redacted.log');
  const finalPath = path.join(run.run_dir, 'codex-final.md');

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await writeFileAtomic(promptArtifactPath, opts.prompt);
  await addArtifacts(run.run_dir, [
    { path: promptArtifactPath, visibility: 'local_only', kind: 'prompt' },
    { path: rawLogPath, visibility: 'local_only', kind: 'codex_log' },
    { path: redactedLogPath, visibility: 'redacted_shareable', kind: 'codex_redacted_log' },
  ]);
  await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: now.toISOString(), type: 'artifact', data: { artifacts: ['prompt.md', 'codex.log', 'codex.redacted.log'] } });

  try {
    await git.createWorktree(opts.profile.repo.path, worktreePath, opts.branch, opts.baseRef);
    await git.protectWorktreeFromAgentPush?.(worktreePath, opts.profile.repo.remote);
  } catch (error) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'worktree_creation_failed', new Date());
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { reason: 'worktree_creation_failed', message: error instanceof Error ? error.message : String(error) } });
    return { ok: false, reason: 'worktree_creation_failed' };
  }
  await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: now.toISOString(), type: 'side_effect', data: { side_effect: 'git_worktree_created', worktree_path: worktreePath, branch: opts.branch, base_ref: opts.baseRef } });
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'codex_running', null, now);

  let result: CodexRunResult;
  try {
    result = await codex.run({ cwd: worktreePath, promptPath: promptArtifactPath, rawLogPath, redactedLogPath, agent: opts.profile.agent, recordEvent: async (event) => appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: event.type, ...event.data } }) });
  } catch (error) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'codex_unavailable', new Date());
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { reason: 'codex_unavailable', message: error instanceof Error ? error.message : String(error) } });
    return { ok: false, reason: 'codex_unavailable' };
  }
  if (!result.ok) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, result.reason === 'codex_timeout' ? 'timed_out' : 'failed', codexReasonToRunReason(result.reason), new Date());
    return { ok: false, reason: codexReasonToRunReason(result.reason) };
  }

  try {
    await writeFileAtomic(finalPath, result.finalText);
    await addArtifacts(run.run_dir, [{ path: finalPath, visibility: 'redacted_shareable', kind: 'codex_final' }]);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['codex-final.md'] } });
  } catch (error) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'codex_unavailable', new Date());
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { reason: 'codex_unavailable', message: error instanceof Error ? error.message : String(error) } });
    return { ok: false, reason: 'codex_unavailable' };
  }
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'codex_completed', null, new Date());
  return { ok: true, worktreePath };
}

function codexReasonToRunReason(reason: CodexFailureReason): RunReason {
  return reason;
}

async function addArtifacts(runDir: string, newArtifacts: RunArtifact[]): Promise<void> {
  const artifactsPath = path.join(runDir, 'artifacts.json');
  const manifest = JSON.parse(await readFile(artifactsPath, 'utf8')) as ArtifactsManifest;
  const byPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of newArtifacts) byPath.set(artifact.path, artifact);
  await writeJsonAtomic(artifactsPath, { ...manifest, artifacts: [...byPath.values()] });
}

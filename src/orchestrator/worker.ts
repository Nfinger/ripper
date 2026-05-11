import { runTurn } from '../agent/runner.js';
import type { AgentEvent, TurnResult } from '../agent/types.js';
import type { Issue, ServiceConfig } from '../workflow/types.js';
import { renderPrompt } from '../agent/prompt.js';
import type { TrackerClient } from '../tracker/types.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { processWorkspaceArtifacts } from './artifacts.js';
import type { WorkerExit } from './state.js';
import { log } from '../log.js';

export interface WorkerCallbacks {
  onAgentEvent(issue_id: string, event: AgentEvent): void;
  onTurnFinished(issue_id: string, turnNumber: number, result: TurnResult): void;
}

export interface WorkerArgs {
  issue: Issue;
  attempt: number | null;
  workspace: WorkspaceManager;
  tracker: TrackerClient;
  promptTemplate: string;
  config: ServiceConfig;
  signal: AbortSignal;
  callbacks: WorkerCallbacks;
}

/**
 * One worker = one or more turns inside a single workspace, refreshing tracker
 * state between turns. Spec §7.1 / §16.5.
 */
export async function runIssueWorker(args: WorkerArgs): Promise<WorkerExit> {
  const ws = await args.workspace.createForIssue(args.issue.identifier);
  if (!ws.ok) {
    return { kind: 'workspace_error', reason: `${ws.error.code}: ${ws.error.message}` };
  }
  if (args.signal.aborted) return { kind: 'cancelled', reason: cancelReason(args.signal) };

  const beforeRun = await args.workspace.runBeforeRun(ws.value.path);
  if (!beforeRun.ok) {
    await args.workspace.runAfterRun(ws.value.path);
    return { kind: 'workspace_error', reason: `${beforeRun.error.code}: ${beforeRun.error.message}` };
  }

  let issue = args.issue;
  let threadId: string | null = null;
  let turnNumber = 0;
  const maxTurns = args.config.agent.max_turns;
  const activeSet = new Set(args.config.tracker.active_states.map((s) => s.toLowerCase()));

  let exit: WorkerExit | null = null;

  while (turnNumber < maxTurns) {
    if (args.signal.aborted) {
      exit = { kind: 'cancelled', reason: cancelReason(args.signal) };
      break;
    }
    turnNumber += 1;
    const promptInputs = {
      issue,
      attempt: args.attempt,
      turn: turnNumber,
    };
    const promptText =
      turnNumber === 1
        ? args.promptTemplate
        : continuationPromptFor(issue, turnNumber, maxTurns);
    const rendered =
      turnNumber === 1
        ? await renderPrompt(promptText, promptInputs)
        : ({ ok: true as const, value: promptText });
    if (!rendered.ok) {
      exit = { kind: 'failed', reason: `${rendered.error.code}: ${rendered.error.message}`, turns: turnNumber };
      break;
    }

    const result = await runTurn({
      workspacePath: ws.value.path,
      agentKind: args.config.agent_runtime.kind,
      command: args.config.agent_runtime.command,
      resumeThreadId: threadId,
      permissionMode: args.config.agent_runtime.permission_mode,
      prompt: rendered.value,
      turnNumber,
      turnTimeoutMs: args.config.agent_runtime.turn_timeout_ms,
      onEvent: (e) => args.callbacks.onAgentEvent(issue.id, e),
    });
    args.callbacks.onTurnFinished(issue.id, turnNumber, result);
    if (result.thread_id) threadId = result.thread_id;

    if (result.outcome === 'startup_failed') {
      exit = { kind: 'startup_failed', reason: result.reason ?? 'startup failed' };
      break;
    }
    if (result.outcome === 'timeout') {
      exit = { kind: 'timeout', reason: result.reason ?? 'turn timeout', turns: turnNumber };
      break;
    }
    if (result.outcome === 'failed') {
      exit = { kind: 'failed', reason: result.reason ?? 'turn failed', turns: turnNumber };
      break;
    }

    // Successful turn — sweep any artifacts (videos/screenshots/etc) the
    // worker dropped into .symphony/artifacts/ and surface them on the issue
    // before the next turn or clean exit.
    try {
      await processWorkspaceArtifacts({
        workspacePath: ws.value.path,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        tracker: args.tracker,
      });
    } catch (err) {
      log.warn(
        { issue_id: issue.id, identifier: issue.identifier, err: (err as Error).message },
        'artifact pass threw — continuing',
      );
    }

    // succeeded — re-check tracker state before deciding to continue.
    if (args.signal.aborted) {
      exit = { kind: 'cancelled', reason: cancelReason(args.signal) };
      break;
    }
    const refresh = await args.tracker.fetch_issue_states_by_ids([issue.id]);
    if (!refresh.ok) {
      exit = { kind: 'failed', reason: `tracker refresh failed: ${refresh.error.code}`, turns: turnNumber };
      break;
    }
    const refreshed = refresh.value[0];
    if (!refreshed) {
      // issue disappeared — clean exit; orchestrator will release claim.
      exit = { kind: 'normal', turns: turnNumber };
      break;
    }
    if (!activeSet.has(refreshed.state.toLowerCase())) {
      exit = { kind: 'normal', turns: turnNumber };
      break;
    }
    issue = { ...issue, state: refreshed.state };
  }

  if (!exit) exit = { kind: 'normal', turns: turnNumber };

  // Final artifact sweep — picks up files written between the last turn's
  // upload pass and worker exit (e.g. recordings completed during a failed
  // continuation turn).
  try {
    await processWorkspaceArtifacts({
      workspacePath: ws.value.path,
      issueId: args.issue.id,
      issueIdentifier: args.issue.identifier,
      tracker: args.tracker,
    });
  } catch (err) {
    log.warn(
      { issue_id: args.issue.id, identifier: args.issue.identifier, err: (err as Error).message },
      'final artifact pass threw — continuing',
    );
  }

  // after_run is best-effort; failure logged but ignored.
  const ar = await args.workspace.runAfterRun(ws.value.path);
  if (!ar.ok) {
    log.warn(
      { issue_id: args.issue.id, identifier: args.issue.identifier, hook: 'after_run', err: ar.error },
      'after_run hook failed (logged and ignored per spec §9.4)',
    );
  }
  return exit;
}

function cancelReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (typeof r === 'string') return r;
  if (r instanceof Error) return r.message;
  return 'cancelled';
}

function continuationPromptFor(issue: Issue, turn: number, maxTurns: number): string {
  return `The previous turn for ${issue.identifier} ended cleanly. The issue is still in state "${issue.state}". This is turn ${turn} of at most ${maxTurns}. Continue your work; reuse the existing thread state. If you have already finished, report a clean handoff and stop.`;
}

import { log } from './log.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { createTrackerClient } from './tracker/factory.js';
import type { TrackerClient } from './tracker/types.js';
import { buildServiceConfig, validateForDispatch } from './workflow/config.js';
import { isValidationError, loadWorkflowFile } from './workflow/loader.js';
import { watchWorkflow, type WorkflowWatcher } from './workflow/watcher.js';
import type { Profile } from './workflow/profile.js';
import { WorkspaceManager } from './workspace/manager.js';

export interface ProfileRuntime {
  profile: Profile;
  tracker: TrackerClient;
  workspace: WorkspaceManager;
  orchestrator: Orchestrator;
  watcher: WorkflowWatcher;
}

export class Daemon {
  private readonly runtimes: ProfileRuntime[] = [];

  /**
   * Test/DI escape hatch — wrap a pre-built list of runtimes (used to inject
   * fake trackers/workers) without going through tracker.factory or building
   * watchers.
   */
  static fromRuntimes(runtimes: ProfileRuntime[]): Daemon {
    const d = Object.create(Daemon.prototype) as unknown as { runtimes: ProfileRuntime[] };
    d.runtimes = runtimes;
    return d as unknown as Daemon;
  }

  constructor(profiles: Profile[]) {
    for (const profile of profiles) {
      const trackerRes = createTrackerClient(profile.config.tracker);
      if (!trackerRes.ok) {
        throw new Error(
          `[${profile.name}] tracker init failed: ${trackerRes.error.code} — ${trackerRes.error.message}`,
        );
      }
      const tracker = trackerRes.value;
      const workspace = new WorkspaceManager({
        workspaceRoot: profile.config.workspace.root,
        hooks: profile.config.hooks,
      });
      const orchestrator = new Orchestrator({
        config: profile.config,
        tracker,
        workspace,
      });
      const watcher = watchWorkflow({
        workflowPath: profile.path,
        current: profile.config,
        onApply: (next) => {
          orchestrator.applyConfig(next);
          profile.config = next;
        },
      });
      this.runtimes.push({ profile, tracker, workspace, orchestrator, watcher });
    }
  }

  getRuntimes(): ProfileRuntime[] {
    return this.runtimes;
  }

  /**
   * Per-profile startup terminal-state cleanup, then schedule first tick.
   * Cleanup failures are logged and swallowed (spec §8.6).
   */
  async start(): Promise<void> {
    for (const runtime of this.runtimes) {
      log.info(
        {
          client: runtime.profile.name,
          tracker_kind: runtime.profile.config.tracker.kind,
          team_key: runtime.profile.config.tracker.team_key,
          project_slug: runtime.profile.config.tracker.project_slug,
          workspace_root: runtime.profile.config.workspace.root,
          poll_interval_ms: runtime.profile.config.polling.interval_ms,
        },
        'profile starting',
      );
      try {
        await runtime.orchestrator.startupCleanup();
      } catch (err) {
        log.warn(
          { client: runtime.profile.name, err: (err as Error).message },
          'startup cleanup threw',
        );
      }
      runtime.orchestrator.scheduleTick(0);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.runtimes.map(async (runtime) => {
        runtime.watcher.stop();
        await runtime.orchestrator.shutdown();
      }),
    );
  }

  /**
   * Triggers an immediate tick across all profiles. Used by HTTP /api/v1/refresh.
   */
  triggerRefresh(): void {
    for (const runtime of this.runtimes) {
      void runtime.orchestrator.tick();
    }
  }
}

/**
 * Helper used when reloading after edits — not currently invoked from CLI but
 * kept here so the watcher path is symmetric with what the daemon does on
 * startup.
 */
export function rebuildProfileFromPath(workflowPath: string): Profile | null {
  const wf = loadWorkflowFile(workflowPath);
  if (isValidationError(wf)) return null;
  const config = buildServiceConfig(wf, workflowPath);
  if (validateForDispatch(config)) return null;
  return { name: '', path: workflowPath, config };
}

import fs from 'node:fs';

import { log } from '../log.js';
import { buildServiceConfig, validateForDispatch } from './config.js';
import { isValidationError, loadWorkflowFile } from './loader.js';
import type { ServiceConfig } from './types.js';

export interface WorkflowWatcher {
  stop(): void;
}

/**
 * Spec §6.2 — re-read WORKFLOW.md on filesystem change and re-apply if valid.
 * Invalid reloads are logged and ignored — caller keeps the last good config.
 */
export function watchWorkflow(args: {
  workflowPath: string;
  current: ServiceConfig;
  onApply: (next: ServiceConfig) => void;
}): WorkflowWatcher {
  let lastDigest = digestOf(args.current);
  let pending: NodeJS.Timeout | null = null;

  const fireReload = () => {
    pending = null;
    const wf = loadWorkflowFile(args.workflowPath);
    if (isValidationError(wf)) {
      log.warn({ err: wf }, 'workflow reload failed; keeping last good config');
      return;
    }
    const next = buildServiceConfig(wf, args.workflowPath);
    const validation = validateForDispatch(next);
    if (validation) {
      log.warn({ err: validation }, 'workflow reload failed validation; keeping last good config');
      return;
    }
    const digest = digestOf(next);
    if (digest === lastDigest) return;
    lastDigest = digest;
    args.onApply(next);
    log.info(
      {
        poll_interval_ms: next.polling.interval_ms,
        max_concurrent_agents: next.agent.max_concurrent_agents,
      },
      'workflow reloaded',
    );
  };

  let watcher: fs.FSWatcher | null;
  try {
    watcher = fs.watch(args.workflowPath, () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(fireReload, 100);
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'fs.watch unavailable; reload disabled');
    watcher = null;
  }

  return {
    stop() {
      if (pending) clearTimeout(pending);
      watcher?.close();
    },
  };
}

function digestOf(config: ServiceConfig): string {
  return JSON.stringify({
    p: config.polling.interval_ms,
    c: config.agent.max_concurrent_agents,
    a: config.agent.max_concurrent_agents_by_state,
    t: config.tracker.active_states,
    x: config.tracker.terminal_states,
    h: {
      ac: config.hooks.after_create,
      br: config.hooks.before_run,
      ar: config.hooks.after_run,
      brm: config.hooks.before_remove,
      to: config.hooks.timeout_ms,
    },
    cl: config.claude,
    pr: config.prompt_template,
  });
}

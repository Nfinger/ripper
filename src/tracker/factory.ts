import type { TrackerConfig } from '../workflow/types.js';
import { createJiraClient } from './jira.js';
import { createLinearClient } from './linear.js';
import type { TrackerClient, TrackerResult } from './types.js';

/**
 * Pick the right adapter based on `tracker.kind`. Adding a new tracker means
 * implementing the `TrackerClient` interface and adding a case here — nothing
 * else in the orchestrator needs to know what's underneath.
 */
export function createTrackerClient(
  tracker: TrackerConfig,
  fetchImpl?: typeof fetch,
): TrackerResult<TrackerClient> {
  switch (tracker.kind) {
    case 'linear':
      return createLinearClient(tracker, fetchImpl);
    case 'jira':
      return createJiraClient(tracker, fetchImpl);
    default:
      return {
        ok: false,
        error: {
          code: 'unsupported_tracker_kind',
          kind: tracker.kind,
          message: `Tracker kind "${tracker.kind}" is not supported (expected: linear, jira)`,
        },
      };
  }
}

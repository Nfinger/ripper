import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import type { TrackerClient } from '../tracker/types.js';

/**
 * Convention: the agent worker writes artifacts (videos, screenshots, logs
 * proving its implementation) into `<workspace>/.symphony/artifacts/`. After
 * each successful turn the orchestrator scans that directory, uploads any
 * file that's not yet been processed to the tracker, and moves it to
 * `.symphony/artifacts/uploaded/` so the same file isn't re-uploaded next turn.
 */

const ARTIFACTS_RELATIVE = '.symphony/artifacts';
const UPLOADED_SUBDIR = 'uploaded';

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
};

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50MB; bigger than this is almost certainly accidental.

export interface ArtifactUploadOutcome {
  filename: string;
  status: 'uploaded' | 'skipped' | 'failed';
  url?: string;
  reason?: string;
}

export async function processWorkspaceArtifacts(args: {
  workspacePath: string;
  issueId: string;
  issueIdentifier: string;
  tracker: TrackerClient;
}): Promise<ArtifactUploadOutcome[]> {
  if (typeof args.tracker.upload_attachment !== 'function') return [];
  const root = path.join(args.workspacePath, ARTIFACTS_RELATIVE);
  if (!fs.existsSync(root)) return [];

  const uploadedDir = path.join(root, UPLOADED_SUBDIR);
  fs.mkdirSync(uploadedDir, { recursive: true });

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile());
  const outcomes: ArtifactUploadOutcome[] = [];

  for (const entry of entries) {
    const sourcePath = path.join(root, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      continue;
    }
    if (stat.size === 0) {
      outcomes.push({ filename: entry.name, status: 'skipped', reason: 'empty file' });
      continue;
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      outcomes.push({
        filename: entry.name,
        status: 'skipped',
        reason: `file > ${MAX_ARTIFACT_BYTES} bytes`,
      });
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
    const result = await args.tracker.upload_attachment(args.issueId, args.issueIdentifier, {
      path: sourcePath,
      filename: entry.name,
      contentType,
    });
    if (!result.ok) {
      outcomes.push({
        filename: entry.name,
        status: 'failed',
        reason: `${result.error.code}: ${result.error.message}`,
      });
      log.warn(
        {
          identifier: args.issueIdentifier,
          file: entry.name,
          err: result.error,
        },
        'artifact upload failed',
      );
      continue;
    }
    outcomes.push({
      filename: entry.name,
      status: 'uploaded',
      url: result.value.url,
    });
    // Move to uploaded/ so we don't re-process next turn.
    try {
      fs.renameSync(sourcePath, path.join(uploadedDir, entry.name));
    } catch (err) {
      log.warn(
        {
          identifier: args.issueIdentifier,
          file: entry.name,
          err: (err as Error).message,
        },
        'artifact uploaded but could not be moved to uploaded/ — may be re-uploaded next turn',
      );
    }
  }

  if (outcomes.length > 0) {
    const summary = outcomes.reduce(
      (acc, o) => {
        acc[o.status] = (acc[o.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    log.info(
      { identifier: args.issueIdentifier, summary },
      'artifact upload pass complete',
    );
  }
  return outcomes;
}

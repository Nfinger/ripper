import fs from 'node:fs';
import path from 'node:path';

import { buildServiceConfig, validateForDispatch } from './config.js';
import { isValidationError, loadWorkflowFile } from './loader.js';
import type { ServiceConfig, ValidationError } from './types.js';

export interface Profile {
  /** Stable client name. Comes from filename stem ("rhema.WORKFLOW.md" → "rhema"). */
  name: string;
  /** Absolute path to the source WORKFLOW.md. */
  path: string;
  /** Validated, defaults-applied config. */
  config: ServiceConfig;
}

export type ProfileError =
  | { code: 'profile_load_failed'; path: string; cause: ValidationError }
  | { code: 'profile_validation_failed'; path: string; cause: ValidationError }
  | { code: 'config_dir_not_found'; path: string; message: string }
  | { code: 'config_dir_empty'; path: string; message: string };

export type ProfileResult = { ok: true; profiles: Profile[] } | { ok: false; error: ProfileError };

const WORKFLOW_GLOB_RE = /\.WORKFLOW\.md$/i;

/**
 * Load a single WORKFLOW.md (back-compat single-profile mode). Profile name is
 * the filename stem with `.WORKFLOW.md` (or `.md`) stripped — falls back to
 * `default` if the file is just `WORKFLOW.md`.
 */
export function loadProfileFromFile(workflowPath: string): ProfileResult {
  const abs = path.resolve(workflowPath);
  const wf = loadWorkflowFile(abs);
  if (isValidationError(wf)) {
    return { ok: false, error: { code: 'profile_load_failed', path: abs, cause: wf } };
  }
  const config = buildServiceConfig(wf, abs);
  const validation = validateForDispatch(config);
  if (validation) {
    return {
      ok: false,
      error: { code: 'profile_validation_failed', path: abs, cause: validation },
    };
  }
  return {
    ok: true,
    profiles: [{ name: deriveProfileName(abs), path: abs, config }],
  };
}

/**
 * Load every `*.WORKFLOW.md` file from a directory. Empty directory or missing
 * dir is an error; an individual file failing validation aborts the whole load
 * (we don't want to silently start the daemon with a partial config).
 */
export function loadProfilesFromDir(dirPath: string): ProfileResult {
  const abs = path.resolve(dirPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return {
      ok: false,
      error: {
        code: 'config_dir_not_found',
        path: abs,
        message: `--config-dir ${abs} is not a directory`,
      },
    };
  }
  const entries = fs.readdirSync(abs).filter((f) => WORKFLOW_GLOB_RE.test(f));
  if (entries.length === 0) {
    return {
      ok: false,
      error: {
        code: 'config_dir_empty',
        path: abs,
        message: `--config-dir ${abs} contains no *.WORKFLOW.md files`,
      },
    };
  }
  entries.sort();
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const full = path.join(abs, entry);
    const result = loadProfileFromFile(full);
    if (!result.ok) return result;
    for (const profile of result.profiles) {
      if (seen.has(profile.name)) {
        return {
          ok: false,
          error: {
            code: 'profile_validation_failed',
            path: full,
            cause: {
              code: 'invalid_config_value',
              field: 'name',
              message: `Duplicate profile name "${profile.name}" — rename one of the WORKFLOW.md files`,
            },
          },
        };
      }
      seen.add(profile.name);
      profiles.push(profile);
    }
  }
  return { ok: true, profiles };
}

export function deriveProfileName(workflowPath: string): string {
  const base = path.basename(workflowPath);
  const stem = base.replace(WORKFLOW_GLOB_RE, '').replace(/\.md$/i, '');
  if (stem.length === 0) return 'default';
  if (stem.toLowerCase() === 'workflow') return 'default';
  return stem;
}

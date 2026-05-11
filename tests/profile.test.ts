import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveProfileName, loadProfileFromFile, loadProfilesFromDir } from '../src/workflow/profile.js';

const ORIGINAL_ENV = { ...process.env };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-prof-'));
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

const VALID_LINEAR_FRONT_MATTER = `---
tracker:
  kind: linear
  team_key: MFL
---
Work on {{ issue.identifier }}.
`;

const VALID_JIRA_FRONT_MATTER = `---
tracker:
  kind: jira
  endpoint: https://timehawk.atlassian.net
  email: nate@timehawk.ai
  api_key: $JIRA_API_TOKEN
  project_slug: TH
---
Jira issue {{ issue.identifier }}.
`;

function write(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('deriveProfileName', () => {
  it('strips .WORKFLOW.md', () => {
    expect(deriveProfileName('/x/clients/rhema.WORKFLOW.md')).toBe('rhema');
  });
  it('strips .md', () => {
    expect(deriveProfileName('/x/timehawk.md')).toBe('timehawk');
  });
  it('falls back to default for bare WORKFLOW.md', () => {
    expect(deriveProfileName('/x/WORKFLOW.md')).toBe('default');
  });
});

describe('loadProfileFromFile', () => {
  it('builds a single profile from a valid file', () => {
    process.env.LINEAR_API_KEY = 'k';
    const p = write('rhema.WORKFLOW.md', VALID_LINEAR_FRONT_MATTER);
    const res = loadProfileFromFile(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profiles).toHaveLength(1);
      expect(res.profiles[0]?.name).toBe('rhema');
      expect(res.profiles[0]?.config.tracker.team_key).toBe('MFL');
    }
  });

  it('surfaces validation errors', () => {
    const p = write('rhema.WORKFLOW.md', VALID_LINEAR_FRONT_MATTER); // no LINEAR_API_KEY in env
    delete process.env.LINEAR_API_KEY;
    const res = loadProfileFromFile(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('profile_validation_failed');
  });
});

describe('loadProfilesFromDir', () => {
  it('loads every *.WORKFLOW.md in a directory', () => {
    process.env.LINEAR_API_KEY = 'k';
    process.env.JIRA_API_TOKEN = 'jt';
    write('rhema.WORKFLOW.md', VALID_LINEAR_FRONT_MATTER);
    write('timehawk.WORKFLOW.md', VALID_JIRA_FRONT_MATTER);
    write('README.md', '# not a workflow');
    const res = loadProfilesFromDir(tmp);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profiles.map((p) => p.name).sort()).toEqual(['rhema', 'timehawk']);
      expect(res.profiles.find((p) => p.name === 'timehawk')?.config.tracker.kind).toBe('jira');
    }
  });

  it('errors when the directory has no WORKFLOW files', () => {
    write('README.md', 'nope');
    const res = loadProfilesFromDir(tmp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('config_dir_empty');
  });

  it('errors when the directory does not exist', () => {
    const res = loadProfilesFromDir(path.join(tmp, 'nope'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('config_dir_not_found');
  });

  it('aborts the load when one profile is invalid', () => {
    process.env.LINEAR_API_KEY = 'k';
    write('rhema.WORKFLOW.md', VALID_LINEAR_FRONT_MATTER);
    write(
      'broken.WORKFLOW.md',
      `---\ntracker:\n  kind: jira\n---\n`,
    );
    const res = loadProfilesFromDir(tmp);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('profile_validation_failed');
  });
});

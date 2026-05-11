import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isValidationError, loadWorkflowFile, parseWorkflowSource } from '../src/workflow/loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-loader-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadWorkflowFile', () => {
  it('returns missing_workflow_file when path does not exist', () => {
    const res = loadWorkflowFile(path.join(tmpDir, 'nope.md'));
    expect(isValidationError(res)).toBe(true);
    if (isValidationError(res)) {
      expect(res.code).toBe('missing_workflow_file');
    }
  });

  it('returns config + prompt_template on a valid file', () => {
    const p = write(
      'WORKFLOW.md',
      `---
tracker:
  kind: linear
  project_slug: market-savvy
---
Do the thing for {{ issue.identifier }}.
`,
    );
    const res = loadWorkflowFile(p);
    expect(isValidationError(res)).toBe(false);
    if (!isValidationError(res)) {
      expect(res.config.tracker).toMatchObject({ kind: 'linear', project_slug: 'market-savvy' });
      expect(res.prompt_template).toBe('Do the thing for {{ issue.identifier }}.');
    }
  });
});

describe('parseWorkflowSource', () => {
  it('treats body-only files as prompt with empty config', () => {
    const res = parseWorkflowSource('Just a prompt with no front matter.\n');
    expect(isValidationError(res)).toBe(false);
    if (!isValidationError(res)) {
      expect(res.config).toEqual({});
      expect(res.prompt_template).toBe('Just a prompt with no front matter.');
    }
  });

  it('errors on unclosed front matter', () => {
    const res = parseWorkflowSource('---\ntracker:\n  kind: linear\nprompt body without closing\n');
    expect(isValidationError(res)).toBe(true);
    if (isValidationError(res)) expect(res.code).toBe('workflow_parse_error');
  });

  it('errors on invalid YAML', () => {
    const res = parseWorkflowSource('---\ntracker: : invalid : yaml\n---\nbody\n');
    expect(isValidationError(res)).toBe(true);
    if (isValidationError(res)) expect(res.code).toBe('workflow_parse_error');
  });

  it('errors when front matter is not a map', () => {
    const res = parseWorkflowSource('---\n- one\n- two\n---\nbody\n');
    expect(isValidationError(res)).toBe(true);
    if (isValidationError(res)) expect(res.code).toBe('workflow_front_matter_not_a_map');
  });

  it('handles empty front matter', () => {
    const res = parseWorkflowSource('---\n---\njust the body\n');
    expect(isValidationError(res)).toBe(false);
    if (!isValidationError(res)) {
      expect(res.config).toEqual({});
      expect(res.prompt_template).toBe('just the body');
    }
  });

  it('trims prompt body', () => {
    const res = parseWorkflowSource('---\nx: 1\n---\n\n\nhello\n\n\n');
    expect(isValidationError(res)).toBe(false);
    if (!isValidationError(res)) {
      expect(res.prompt_template).toBe('hello');
    }
  });
});

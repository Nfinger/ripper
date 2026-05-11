import { describe, expect, it } from 'vitest';

import { renderPrompt } from '../src/agent/prompt.js';
import type { Issue } from '../src/workflow/types.js';

const ISSUE: Issue = {
  id: 'uuid-1',
  identifier: 'MS-101',
  title: 'Add login flow',
  description: 'The user can log in.',
  priority: 2,
  state: 'Todo',
  branch_name: 'nate/ms-101-login',
  url: 'https://linear.app/MS/issue/MS-101',
  labels: ['frontend', 'auth'],
  blocked_by: [{ id: 'uuid-99', identifier: 'MS-99', state: 'In Progress' }],
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-02T00:00:00.000Z',
};

describe('renderPrompt', () => {
  it('renders issue + attempt variables', async () => {
    const tmpl = 'Issue {{ issue.identifier }}: {{ issue.title }} (attempt={{ attempt }})';
    const res = await renderPrompt(tmpl, { issue: ISSUE, attempt: null });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('Issue MS-101: Add login flow (attempt=)');
  });

  it('iterates labels and blockers', async () => {
    const tmpl = `{% for l in issue.labels %}{{ l }};{% endfor %}|{% for b in issue.blocked_by %}{{ b.identifier }}({{ b.state }});{% endfor %}`;
    const res = await renderPrompt(tmpl, { issue: ISSUE, attempt: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('frontend;auth;|MS-99(In Progress);');
  });

  it('fails on unknown variable', async () => {
    const tmpl = 'Hello {{ issue.does_not_exist }}';
    const res = await renderPrompt(tmpl, { issue: ISSUE, attempt: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('template_render_error');
  });

  it('fails on unknown filter', async () => {
    const tmpl = '{{ issue.identifier | not_a_filter }}';
    const res = await renderPrompt(tmpl, { issue: ISSUE, attempt: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('template_render_error');
  });
});

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LinearClient, normalizeFullIssue } from '../src/tracker/linear.js';

function makeClient(fetchImpl: typeof fetch, opts: { teamKey?: string | null; projectSlug?: string | null } = {}): LinearClient {
  const projectSlug = 'projectSlug' in opts ? opts.projectSlug ?? null : 'market-savvy';
  return new LinearClient({
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'lin_api_test',
    teamKey: opts.teamKey ?? null,
    projectSlug,
    activeStates: ['Todo', 'In Progress'],
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RAW_ISSUE_NODE = {
  id: 'issue-uuid-1',
  identifier: 'MS-101',
  title: 'Add login flow',
  description: 'do it',
  priority: 2,
  branchName: 'nate/ms-101-login',
  url: 'https://linear.app/.../MS-101',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
  state: { name: 'Todo' },
  assignee: { id: 'user-1', name: 'Nathaniel Finger' },
  labels: { nodes: [{ name: 'Frontend' }, { name: 'API' }] },
  inverseRelations: {
    nodes: [
      { type: 'blocks', issue: { id: 'blocker-1', identifier: 'MS-99', state: { name: 'In Progress' } } },
      { type: 'related', issue: { id: 'related-1', identifier: 'MS-50', state: { name: 'Done' } } },
    ],
  },
};

describe('normalizeFullIssue', () => {
  it('lowercases labels and pulls only blocks-typed inverse relations', () => {
    const issue = normalizeFullIssue(RAW_ISSUE_NODE);
    expect(issue).not.toBeNull();
    expect(issue?.labels).toEqual(['frontend', 'api']);
    expect(issue?.assignee_id).toBe('user-1');
    expect(issue?.assignee_name).toBe('Nathaniel Finger');
    expect(issue?.blocked_by).toEqual([
      { id: 'blocker-1', identifier: 'MS-99', state: 'In Progress' },
    ]);
    expect(issue?.priority).toBe(2);
    expect(issue?.branch_name).toBe('nate/ms-101-login');
  });

  it('returns null when required fields are missing', () => {
    expect(normalizeFullIssue({ id: 'x' })).toBeNull();
    expect(normalizeFullIssue(null)).toBeNull();
  });

  it('coerces non-integer priority to null', () => {
    const issue = normalizeFullIssue({ ...RAW_ISSUE_NODE, priority: 'high' });
    expect(issue?.priority).toBeNull();
    const issue2 = normalizeFullIssue({ ...RAW_ISSUE_NODE, priority: 1.5 });
    expect(issue2?.priority).toBeNull();
  });
});

describe('LinearClient.fetch_candidate_issues', () => {
  it('paginates and returns normalized issues', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
              nodes: [RAW_ISSUE_NODE],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  ...RAW_ISSUE_NODE,
                  id: 'uuid-2',
                  identifier: 'MS-102',
                  title: 'Second',
                  inverseRelations: { nodes: [] },
                },
              ],
            },
          },
        }),
      );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.map((i) => i.identifier)).toEqual(['MS-101', 'MS-102']);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1]!;
    const body = JSON.parse(secondCall[1]?.body as string);
    expect(body.variables.cursor).toBe('cur-1');
    expect(body.variables.filter.project).toEqual({ slugId: { eq: 'market-savvy' } });
  });

  it('builds the filter with team and project when both are set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      }),
    );
    const c = makeClient(fetchImpl, { teamKey: 'MFL', projectSlug: 'market-savvy' });
    await c.fetch_candidate_issues();
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.variables.filter.team).toEqual({ key: { eq: 'MFL' } });
    expect(body.variables.filter.project).toEqual({ slugId: { eq: 'market-savvy' } });
    expect(body.variables.filter.state).toEqual({ name: { in: ['Todo', 'In Progress'] } });
  });

  it('builds the filter with assignee ids when set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      }),
    );
    const c = new LinearClient({
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'lin_api_test',
      teamKey: 'RMA',
      projectSlug: null,
      activeStates: ['Todo'],
      assigneeIds: ['user-1'],
      fetchImpl,
    });
    await c.fetch_candidate_issues();
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.variables.filter.state).toEqual({ name: { in: ['Todo'] } });
    expect(body.variables.filter.assignee).toEqual({ id: { in: ['user-1'] } });
  });

  it('omits project filter when only team_key is set (whole-team scope)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      }),
    );
    const c = makeClient(fetchImpl, { teamKey: 'MFL', projectSlug: null });
    await c.fetch_candidate_issues();
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.variables.filter.team).toEqual({ key: { eq: 'MFL' } });
    expect(body.variables.filter).not.toHaveProperty('project');
    expect(body.query).toContain('IssueFilter!');
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_api_test');
  });

  it('flags missing endCursor mid-pagination', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [RAW_ISSUE_NODE],
          },
        },
      }),
    );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('linear_missing_end_cursor');
  });

  it('maps non-200 responses to linear_api_status', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500));
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('linear_api_status');
      if (res.error.code === 'linear_api_status') expect(res.error.status).toBe(500);
    }
  });

  it('maps GraphQL errors to linear_graphql_errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: null, errors: [{ message: 'unauthorized' }] }),
    );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('linear_graphql_errors');
  });

  it('maps fetch failures to linear_api_request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('linear_api_request');
  });
});

describe('LinearClient.fetch_issues_by_states', () => {
  it('returns empty without an API call when input is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const c = makeClient(fetchImpl);
    const res = await c.fetch_issues_by_states([]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('LinearClient.fetch_issue_states_by_ids', () => {
  it('returns minimal issues using the [ID!] variable type', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              { id: 'uuid-1', identifier: 'MS-101', state: { name: 'In Progress' } },
              { id: 'uuid-2', identifier: 'MS-102', state: { name: 'Done' } },
            ],
          },
        },
      }),
    );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_issue_states_by_ids(['uuid-1', 'uuid-2']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([
        { id: 'uuid-1', identifier: 'MS-101', state: 'In Progress' },
        { id: 'uuid-2', identifier: 'MS-102', state: 'Done' },
      ]);
    }
    const call = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(call[1]?.body as string);
    expect(body.query).toContain('[ID!]');
    expect(body.variables.ids).toEqual(['uuid-1', 'uuid-2']);
  });

  it('returns empty without an API call when input is empty', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const c = makeClient(fetchImpl);
    const res = await c.fetch_issue_states_by_ids([]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});



describe('LinearClient.upload_attachment', () => {
  it('does not send contentType to attachmentCreate input', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-artifact-'));
    const filePath = path.join(tmp, 'proof.png');
    fs.writeFileSync(filePath, 'png-ish');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://uploads.example/put',
                assetUrl: 'https://uploads.example/asset.png',
                contentType: 'image/png',
                filename: 'proof.png',
                size: 7,
                headers: [],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: 'att-1', url: 'https://linear.example/att-1' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { commentCreate: { success: true } } }));
    try {
      const c = makeClient(fetchImpl);
      const res = await c.upload_attachment('issue-1', 'MS-101', {
        path: filePath,
        filename: 'proof.png',
        contentType: 'image/png',
      });

      expect(res.ok).toBe(true);
      const attachmentCall = fetchImpl.mock.calls[2]!;
      const body = JSON.parse(attachmentCall[1]?.body as string);
      expect(body.variables.input).toEqual({
        issueId: 'issue-1',
        title: 'proof.png',
        subtitle: 'Symphony agent visual proof',
        url: 'https://uploads.example/asset.png',
      });
      expect(body.variables.input).not.toHaveProperty('contentType');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


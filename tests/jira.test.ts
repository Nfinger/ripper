import { describe, expect, it, vi } from 'vitest';

import { JiraClient, normalizeFullIssue } from '../src/tracker/jira.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): JiraClient {
  return new JiraClient({
    baseUrl: 'https://timehawk.atlassian.net',
    email: 'nate@timehawk.ai',
    apiToken: 'token-xyz',
    projectKey: 'TH',
    activeStates: ['To Do', 'In Progress'],
    fetchImpl,
  });
}

const RAW_ISSUE = {
  key: 'TH-30',
  fields: {
    summary: 'Add dashboard',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'do it' }] }] },
    status: { name: 'In Progress' },
    priority: { id: '2', name: 'High' },
    labels: ['Frontend', 'API'],
    issuelinks: [
      {
        type: { inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: { key: 'TH-29', fields: { status: { name: 'In Progress' } } },
      },
      {
        type: { inward: 'relates to', outward: 'relates to' },
        inwardIssue: { key: 'TH-1', fields: { status: { name: 'Done' } } },
      },
    ],
    created: '2026-04-01T00:00:00.000Z',
    updated: '2026-05-01T00:00:00.000Z',
  },
};

describe('Jira normalizeFullIssue', () => {
  it('flattens ADF description and lowercases labels', () => {
    const issue = normalizeFullIssue(RAW_ISSUE);
    expect(issue).not.toBeNull();
    expect(issue?.identifier).toBe('TH-30');
    expect(issue?.title).toBe('Add dashboard');
    expect(issue?.description).toBe('do it');
    expect(issue?.state).toBe('In Progress');
    expect(issue?.priority).toBe(2);
    expect(issue?.labels).toEqual(['frontend', 'api']);
    expect(issue?.blocked_by).toEqual([
      { id: 'TH-29', identifier: 'TH-29', state: 'In Progress' },
    ]);
  });

  it('returns null when summary or status is missing', () => {
    expect(normalizeFullIssue({ key: 'TH-1', fields: {} })).toBeNull();
  });
});

describe('JiraClient.fetch_candidate_issues', () => {
  it('builds JQL with project + active statuses and Basic auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ issues: [RAW_ISSUE] }),
    );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.map((i) => i.identifier)).toEqual(['TH-30']);

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('https://timehawk.atlassian.net/rest/api/3/search/jql');
    const body = JSON.parse(call[1]?.body as string);
    expect(body.jql).toBe('project = "TH" AND status in ("To Do", "In Progress")');
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('paginates via nextPageToken', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ issues: [RAW_ISSUE], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(
        jsonResponse({ issues: [{ ...RAW_ISSUE, key: 'TH-31' }] }),
      );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.map((i) => i.identifier)).toEqual(['TH-30', 'TH-31']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string);
    expect(second.nextPageToken).toBe('p2');
  });

  it('maps non-200 to linear_api_status', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 401));
    const c = makeClient(fetchImpl);
    const res = await c.fetch_candidate_issues();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('linear_api_status');
      if (res.error.code === 'linear_api_status') expect(res.error.status).toBe(401);
    }
  });
});

describe('JiraClient.fetch_issue_states_by_ids', () => {
  it('returns minimal state rows', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        issues: [
          { key: 'TH-30', fields: { status: { name: 'In Progress' }, summary: 's1' } },
          { key: 'TH-31', fields: { status: { name: 'Done' }, summary: 's2' } },
        ],
      }),
    );
    const c = makeClient(fetchImpl);
    const res = await c.fetch_issue_states_by_ids(['TH-30', 'TH-31']);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual([
        { id: 'TH-30', identifier: 'TH-30', state: 'In Progress' },
        { id: 'TH-31', identifier: 'TH-31', state: 'Done' },
      ]);
    }
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.jql).toBe('key in ("TH-30", "TH-31")');
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

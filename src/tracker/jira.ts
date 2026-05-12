import fs from 'node:fs';

import type { BlockerRef, Issue, TrackerConfig } from '../workflow/types.js';
import type {
  ArtifactUpload,
  AttachmentResult,
  MinimalIssueState,
  TrackerClient,
  TrackerResult,
} from './types.js';

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30_000;

const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'labels',
  'issuelinks',
  'created',
  'updated',
];

export interface JiraClientOptions {
  /** Atlassian site base URL, e.g. https://timehawk.atlassian.net */
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  activeStates: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createJiraClient(
  tracker: TrackerConfig,
  fetchImpl?: typeof fetch,
): TrackerResult<TrackerClient> {
  if (tracker.kind !== 'jira') {
    return {
      ok: false,
      error: {
        code: 'unsupported_tracker_kind',
        kind: tracker.kind,
        message: `Jira adapter cannot serve tracker.kind="${tracker.kind}"`,
      },
    };
  }
  if (!tracker.api_key || !tracker.email) {
    return {
      ok: false,
      error: {
        code: 'missing_tracker_api_key',
        message: 'Jira tracker requires both tracker.api_key and tracker.email',
      },
    };
  }
  if (!tracker.project_slug) {
    return {
      ok: false,
      error: {
        code: 'missing_tracker_project_slug',
        message: 'Jira tracker requires tracker.project_slug (the Jira project key)',
      },
    };
  }
  if (!tracker.endpoint) {
    return {
      ok: false,
      error: {
        code: 'linear_unknown_payload',
        message: 'Jira tracker requires tracker.endpoint (the Atlassian site URL)',
      },
    };
  }
  return {
    ok: true,
    value: new JiraClient({
      baseUrl: stripTrailingSlash(tracker.endpoint),
      email: tracker.email,
      apiToken: tracker.api_key,
      projectKey: tracker.project_slug,
      activeStates: tracker.active_states,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  };
}

export class JiraClient implements TrackerClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly projectKey: string;
  private readonly activeStates: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: JiraClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.authHeader = 'Basic ' + Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64');
    this.projectKey = opts.projectKey;
    this.activeStates = opts.activeStates;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? NETWORK_TIMEOUT_MS;
  }

  async fetch_candidate_issues(): Promise<TrackerResult<Issue[]>> {
    const jql = `project = ${quoteIdentifier(this.projectKey)} AND status in (${this.activeStates.map(quoteString).join(', ')})`;
    return this.searchIssues(jql, ISSUE_FIELDS, normalizeFullIssue);
  }

  async fetch_issues_by_states(
    state_names: string[],
  ): Promise<TrackerResult<Pick<Issue, 'id' | 'identifier'>[]>> {
    if (state_names.length === 0) return { ok: true, value: [] };
    const jql = `project = ${quoteIdentifier(this.projectKey)} AND status in (${state_names.map(quoteString).join(', ')})`;
    return this.searchIssues(jql, ['summary'], (raw) => {
      const obj = asObject(raw);
      const key = obj ? asString(obj.key) : null;
      if (!key) return null;
      return { id: key, identifier: key };
    });
  }

  async fetch_issue_states_by_ids(
    issue_ids: string[],
  ): Promise<TrackerResult<MinimalIssueState[]>> {
    if (issue_ids.length === 0) return { ok: true, value: [] };
    const jql = `key in (${issue_ids.map(quoteString).join(', ')})`;
    return this.searchIssues(jql, ['status', 'summary'], (raw) => {
      const obj = asObject(raw);
      if (!obj) return null;
      const key = asString(obj.key);
      const fields = asObject(obj.fields);
      const status = fields ? asObject(fields.status) : null;
      const stateName = status ? asString(status.name) : null;
      if (!key || !stateName) return null;
      return { id: key, identifier: key, state: stateName };
    });
  }

  /**
   * Jira's attachment upload is a single multipart POST.
   * Spec: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/
   *
   * On Cloud, the issueId param can also be the issueKey (e.g. "TH-30"), so
   * we use the more readable identifier here.
   */
  async upload_attachment(
    _issueId: string,
    issueIdentifier: string,
    artifact: ArtifactUpload,
  ): Promise<TrackerResult<AttachmentResult>> {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(artifact.path);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_unknown_payload',
          message: `cannot read artifact ${artifact.path}: ${(err as Error).message}`,
        },
      };
    }
    const form = new FormData();
    const blob = new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)], {
      type: artifact.contentType,
    });
    form.append('file', blob, artifact.filename);

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueIdentifier)}/attachments`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: this.authHeader,
            // Required by Atlassian to bypass XSRF check on attachment upload.
            'X-Atlassian-Token': 'no-check',
          },
          body: form,
        },
      );
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_api_request',
          message: `Jira attachment upload failed: ${(err as Error).message}`,
        },
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: 'linear_api_status',
          status: res.status,
          body,
          message: `Jira attachment POST returned HTTP ${res.status}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_unknown_payload',
          message: `Jira attachment response was not JSON: ${(err as Error).message}`,
        },
      };
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const first = arr[0];
    const obj = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
    const id = obj && typeof obj.id === 'string' ? obj.id : null;
    const url =
      obj && typeof obj.content === 'string' && obj.content.length > 0 ? obj.content : '';

    // Best-effort comment with a Markdown link so the artifact is visible
    // in the activity stream rather than buried under "Attachments".
    let commented = false;
    try {
      const commentRes = await this.fetchImpl(
        `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueIdentifier)}/comment`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: this.authHeader,
          },
          body: JSON.stringify({
            body: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: `Symphony — visual proof: ${artifact.filename}`,
                      marks: url ? [{ type: 'link', attrs: { href: url } }] : [],
                    },
                  ],
                },
              ],
            },
          }),
        },
      );
      commented = commentRes.ok;
    } catch {
      /* best-effort — leave commented=false */
    }

    return { ok: true, value: { id, url, commented } };
  }

  private async searchIssues<T>(
    jql: string,
    fields: string[],
    parse: (raw: unknown) => T | null,
  ): Promise<TrackerResult<T[]>> {
    const all: T[] = [];
    let nextPageToken: string | undefined = undefined;
    while (true) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/rest/api/3/search/jql`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: this.authHeader,
          },
          body: JSON.stringify({
            jql,
            fields,
            maxResults: PAGE_SIZE,
            ...(nextPageToken ? { nextPageToken } : {}),
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'linear_api_request',
            message: `Jira request failed: ${(err as Error).message}`,
          },
        };
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: 'linear_api_status',
            status: response.status,
            body,
            message: `Jira API returned HTTP ${response.status}`,
          },
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'linear_unknown_payload',
            message: `Jira response was not valid JSON: ${(err as Error).message}`,
          },
        };
      }
      const root = asObject(payload);
      if (!root) {
        return {
          ok: false,
          error: { code: 'linear_unknown_payload', message: 'Jira response was not an object' },
        };
      }
      const issues = asArray(root.issues) ?? [];
      for (const node of issues) {
        const parsed = parse(node);
        if (parsed) all.push(parsed);
      }
      const hasNext = Boolean(root.nextPageToken);
      if (!hasNext) break;
      const next = asString(root.nextPageToken);
      if (!next) break;
      nextPageToken = next;
    }
    return { ok: true, value: all };
  }
}

export function normalizeFullIssue(node: unknown): Issue | null {
  const obj = asObject(node);
  if (!obj) return null;
  const key = asString(obj.key);
  if (!key) return null;
  const fields = asObject(obj.fields);
  if (!fields) return null;
  const status = asObject(fields.status);
  const stateName = status ? asString(status.name) : null;
  const title = asString(fields.summary);
  if (!stateName || !title) return null;

  const description = flattenAdf(fields.description);
  const created = asString(fields.created);
  const updated = asString(fields.updated);

  const priorityObj = asObject(fields.priority);
  let priority: number | null = null;
  if (priorityObj) {
    const idStr = asString(priorityObj.id);
    if (idStr) {
      const n = Number.parseInt(idStr, 10);
      if (!Number.isNaN(n)) priority = n;
    }
  }

  const labelsRaw = asArray(fields.labels) ?? [];
  const labels: string[] = [];
  for (const l of labelsRaw) {
    if (typeof l === 'string') labels.push(l.toLowerCase());
  }

  const blocked: BlockerRef[] = [];
  const links = asArray(fields.issuelinks) ?? [];
  for (const link of links) {
    const linkObj = asObject(link);
    if (!linkObj) continue;
    const type = asObject(linkObj.type);
    const inwardLabel = type ? asString(type.inward) : null;
    const inwardIssue = asObject(linkObj.inwardIssue);
    if (!inwardLabel || !inwardIssue) continue;
    const isBlocker = /\bblocked\b|\bblocks\b/i.test(inwardLabel);
    if (!isBlocker) continue;
    const blockerKey = asString(inwardIssue.key);
    const blockerFields = asObject(inwardIssue.fields);
    const blockerStatus = blockerFields ? asObject(blockerFields.status) : null;
    const blockerState = blockerStatus ? asString(blockerStatus.name) : null;
    blocked.push({ id: blockerKey, identifier: blockerKey, state: blockerState });
  }

  return {
    id: key,
    identifier: key,
    title,
    description,
    priority,
    state: stateName,
    branch_name: null,
    url: null,
    labels,
    assignee_id: null,
    assignee_name: null,
    blocked_by: blocked,
    created_at: created,
    updated_at: updated,
  };
}

function flattenAdf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;
  const collected: string[] = [];
  walkAdf(value, collected);
  if (collected.length === 0) return null;
  return collected.join('\n').trim() || null;
}

function walkAdf(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) walkAdf(v, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === 'string') into.push(obj.text);
  if (Array.isArray(obj.content)) walkAdf(obj.content, into);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

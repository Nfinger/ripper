import fs from 'node:fs';

import type { BlockerRef, Issue, TrackerConfig } from '../workflow/types.js';
import type {
  ArtifactUpload,
  AttachmentResult,
  MinimalIssueState,
  TrackerClient,
  TrackerError,
  TrackerResult,
} from './types.js';

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30_000;

const CANDIDATE_QUERY = /* GraphQL */ `
  query SymphonyCandidates($filter: IssueFilter!, $cursor: String) {
    issues(first: ${PAGE_SIZE}, after: $cursor, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state { name }
        assignee { id name }
        labels { nodes { name } }
        inverseRelations(first: 50) {
          nodes {
            type
            issue { id identifier state { name } }
          }
        }
      }
    }
  }
`;

const ISSUES_BY_STATES_QUERY = /* GraphQL */ `
  query SymphonyIssuesByStates($filter: IssueFilter!, $cursor: String) {
    issues(first: ${PAGE_SIZE}, after: $cursor, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { id identifier }
    }
  }
`;

const ISSUE_STATES_BY_IDS_QUERY = /* GraphQL */ `
  query SymphonyIssueStates($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes { id identifier state { name } }
    }
  }
`;

const FILE_UPLOAD_QUERY = /* GraphQL */ `
  mutation SymphonyFileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile {
        uploadUrl
        assetUrl
        contentType
        filename
        size
        headers { key value }
      }
    }
  }
`;

const ATTACHMENT_CREATE_QUERY = /* GraphQL */ `
  mutation SymphonyAttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      success
      attachment { id url }
    }
  }
`;

const COMMENT_CREATE_QUERY = /* GraphQL */ `
  mutation SymphonyCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id }
    }
  }
`;

const WORKFLOW_STATE_BY_NAME_QUERY = /* GraphQL */ `
  query SymphonyWorkflowStateByName($filter: WorkflowStateFilter!) {
    workflowStates(first: 10, filter: $filter) {
      nodes { id name }
    }
  }
`;

const ISSUE_UPDATE_STATE_QUERY = /* GraphQL */ `
  mutation SymphonyIssueUpdateState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id state { name } }
    }
  }
`;

interface LinearGraphqlResponse {
  data?: unknown;
  errors?: unknown[];
}

interface IssuesPage {
  nodes: unknown[];
  hasNext: boolean;
  endCursor: string | null;
}

interface MinimalIdPage {
  nodes: Array<Pick<Issue, 'id' | 'identifier'>>;
  hasNext: boolean;
  endCursor: string | null;
}

export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  /** Linear team key (issue prefix). When set, the team filter scopes results. */
  teamKey?: string | null;
  /** Linear project slugId. When set alongside teamKey, narrows to one project. */
  projectSlug?: string | null;
  activeStates: string[];
  assigneeIds?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Construct a Linear tracker adapter from a typed TrackerConfig. Returns an
 * error if required fields are missing — callers can surface the error without
 * blowing up startup.
 */
export function createLinearClient(tracker: TrackerConfig, fetchImpl?: typeof fetch): TrackerResult<TrackerClient> {
  if (tracker.kind !== 'linear') {
    return {
      ok: false,
      error: {
        code: 'unsupported_tracker_kind',
        kind: tracker.kind,
        message: `Linear adapter cannot serve tracker.kind="${tracker.kind}"`,
      },
    };
  }
  if (!tracker.api_key) {
    return {
      ok: false,
      error: { code: 'missing_tracker_api_key', message: 'Linear tracker.api_key not resolved' },
    };
  }
  if (!tracker.project_slug && !tracker.team_key) {
    return {
      ok: false,
      error: {
        code: 'missing_tracker_project_slug',
        message: 'Linear adapter needs at least one of tracker.team_key or tracker.project_slug',
      },
    };
  }
  return {
    ok: true,
    value: new LinearClient({
      endpoint: tracker.endpoint,
      apiKey: tracker.api_key,
      teamKey: tracker.team_key,
      projectSlug: tracker.project_slug,
      activeStates: tracker.active_states,
      assigneeIds: tracker.assignee_ids,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    }),
  };
}

export class LinearClient implements TrackerClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly teamKey: string | null;
  private readonly projectSlug: string | null;
  private readonly activeStates: string[];
  private readonly assigneeIds: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LinearClientOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.teamKey = opts.teamKey ?? null;
    this.projectSlug = opts.projectSlug ?? null;
    this.activeStates = opts.activeStates;
    this.assigneeIds = opts.assigneeIds ?? [];
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? NETWORK_TIMEOUT_MS;
  }

  async fetch_candidate_issues(): Promise<TrackerResult<Issue[]>> {
    const all: Issue[] = [];
    let cursor: string | null = null;
    while (true) {
      const res: TrackerResult<IssuesPage> = await this.runQuery<IssuesPage>(
        CANDIDATE_QUERY,
        { filter: this.buildFilter(this.activeStates), cursor },
        parseIssuesPage,
      );
      if (!res.ok) return res;
      for (const node of res.value.nodes) {
        const norm = normalizeFullIssue(node);
        if (norm) all.push(norm);
      }
      if (!res.value.hasNext) break;
      if (!res.value.endCursor) {
        return {
          ok: false,
          error: {
            code: 'linear_missing_end_cursor',
            message: 'pageInfo.hasNextPage=true but endCursor was null',
          },
        };
      }
      cursor = res.value.endCursor;
    }
    return { ok: true, value: all };
  }

  async fetch_issues_by_states(
    state_names: string[],
  ): Promise<TrackerResult<Pick<Issue, 'id' | 'identifier'>[]>> {
    if (state_names.length === 0) return { ok: true, value: [] };
    const all: Array<Pick<Issue, 'id' | 'identifier'>> = [];
    let cursor: string | null = null;
    while (true) {
      const res: TrackerResult<MinimalIdPage> = await this.runQuery<MinimalIdPage>(
        ISSUES_BY_STATES_QUERY,
        { filter: this.buildFilter(state_names), cursor },
        parseMinimalIdPage,
      );
      if (!res.ok) return res;
      all.push(...res.value.nodes);
      if (!res.value.hasNext) break;
      if (!res.value.endCursor) {
        return {
          ok: false,
          error: {
            code: 'linear_missing_end_cursor',
            message: 'pageInfo.hasNextPage=true but endCursor was null',
          },
        };
      }
      cursor = res.value.endCursor;
    }
    return { ok: true, value: all };
  }

  async fetch_issue_states_by_ids(
    issue_ids: string[],
  ): Promise<TrackerResult<MinimalIssueState[]>> {
    if (issue_ids.length === 0) return { ok: true, value: [] };
    const res = await this.runQuery(
      ISSUE_STATES_BY_IDS_QUERY,
      { ids: issue_ids },
      parseMinimalStatePage,
    );
    if (!res.ok) return res;
    return { ok: true, value: res.value };
  }

  async update_issue_state(issueId: string, stateName: string): Promise<TrackerResult<{ state: string }>> {
    const filter: Record<string, unknown> = { name: { eq: stateName } };
    if (this.teamKey) filter.team = { key: { eq: this.teamKey } };
    const stateRes = await this.runQuery(
      WORKFLOW_STATE_BY_NAME_QUERY,
      { filter },
      parseWorkflowStateLookup,
    );
    if (!stateRes.ok) return { ok: false, error: stateRes.error };
    const updateRes = await this.runQuery(
      ISSUE_UPDATE_STATE_QUERY,
      { id: issueId, input: { stateId: stateRes.value.id } },
      parseIssueStateUpdate,
    );
    if (!updateRes.ok) return updateRes;
    return { ok: true, value: updateRes.value };
  }

  /**
   * Linear's three-step upload: ask for upload URL, PUT the bytes, then call
   * attachmentCreate so the file shows up on the issue. We additionally post
   * a comment with a markdown image embed so screenshots render inline; for
   * non-image artifacts we link them.
   */
  async upload_attachment(
    issueId: string,
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
    const size = bytes.length;
    const slot = await this.runQuery(
      FILE_UPLOAD_QUERY,
      { contentType: artifact.contentType, filename: artifact.filename, size },
      parseFileUpload,
    );
    if (!slot.ok) return slot;
    if (!slot.value.uploadUrl || !slot.value.assetUrl) {
      return {
        ok: false,
        error: { code: 'linear_unknown_payload', message: 'fileUpload returned without URLs' },
      };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': artifact.contentType,
        'Cache-Control': 'public, max-age=31536000',
      };
      for (const h of slot.value.headers) headers[h.key] = h.value;
      const putRes = await this.fetchImpl(slot.value.uploadUrl, {
        method: 'PUT',
        headers,
        // The fetch API on Node accepts Uint8Array bodies. Buffer is a Uint8Array.
        body: bytes,
      });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: 'linear_api_status',
            status: putRes.status,
            body,
            message: `Linear upload PUT returned HTTP ${putRes.status}`,
          },
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_api_request',
          message: `Linear upload PUT failed: ${(err as Error).message}`,
        },
      };
    }

    const isImage = artifact.contentType.startsWith('image/');
    const attachRes = await this.runQuery(
      ATTACHMENT_CREATE_QUERY,
      {
        input: {
          issueId,
          title: artifact.filename,
          subtitle: 'Symphony agent visual proof',
          url: slot.value.assetUrl,
        },
      },
      parseAttachment,
    );
    if (!attachRes.ok) return attachRes;

    // Best-effort comment so the artifact renders inline (images) or has a
    // clear pointer (videos). Failure here doesn't fail the whole upload.
    let commented = false;
    const body = isImage
      ? `**Symphony — visual proof**\n\n![${artifact.filename}](${slot.value.assetUrl})`
      : `**Symphony — visual proof**\n\n[${artifact.filename}](${slot.value.assetUrl}) (${artifact.contentType}, ${formatSize(size)})`;
    const commentRes = await this.runQuery(
      COMMENT_CREATE_QUERY,
      { input: { issueId, body } },
      parseComment,
    );
    commented = commentRes.ok && commentRes.value.success;
    void issueIdentifier;

    return {
      ok: true,
      value: {
        id: attachRes.value.id,
        url: slot.value.assetUrl,
        commented,
      },
    };
  }

  private buildFilter(states: string[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      state: { name: { in: states } },
    };
    if (this.teamKey) filter.team = { key: { eq: this.teamKey } };
    if (this.projectSlug) filter.project = { slugId: { eq: this.projectSlug } };
    if (this.assigneeIds.length > 0) filter.assignee = { id: { in: this.assigneeIds } };
    return filter;
  }

  private async runQuery<T>(
    query: string,
    variables: Record<string, unknown>,
    parser: (data: unknown) => TrackerResult<T>,
  ): Promise<TrackerResult<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_api_request',
          message: `Linear request failed: ${(err as Error).message}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await safeReadBody(response);
      return {
        ok: false,
        error: {
          code: 'linear_api_status',
          status: response.status,
          body,
          message: `Linear API returned HTTP ${response.status}`,
        },
      };
    }
    let payload: LinearGraphqlResponse;
    try {
      payload = (await response.json()) as LinearGraphqlResponse;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'linear_unknown_payload',
          message: `Linear response was not valid JSON: ${(err as Error).message}`,
        },
      };
    }
    if (payload.errors && payload.errors.length > 0) {
      return {
        ok: false,
        error: {
          code: 'linear_graphql_errors',
          errors: payload.errors,
          message: 'Linear GraphQL response contained errors',
        },
      };
    }
    return parser(payload.data);
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseIssuesPage(data: unknown): TrackerResult<{
  nodes: unknown[];
  hasNext: boolean;
  endCursor: string | null;
}> {
  const root = asObject(data);
  const issues = root ? asObject(root.issues) : null;
  if (!issues) {
    return {
      ok: false,
      error: {
        code: 'linear_unknown_payload',
        message: 'response missing issues object',
      },
    };
  }
  const nodes = asArray(issues.nodes) ?? [];
  const pageInfo = asObject(issues.pageInfo);
  const hasNext = pageInfo ? Boolean(pageInfo.hasNextPage) : false;
  const endCursor = pageInfo ? asString(pageInfo.endCursor) : null;
  return { ok: true, value: { nodes, hasNext, endCursor } };
}

function parseMinimalIdPage(data: unknown): TrackerResult<{
  nodes: Array<Pick<Issue, 'id' | 'identifier'>>;
  hasNext: boolean;
  endCursor: string | null;
}> {
  const page = parseIssuesPage(data);
  if (!page.ok) return page;
  const out: Array<Pick<Issue, 'id' | 'identifier'>> = [];
  for (const node of page.value.nodes) {
    const obj = asObject(node);
    if (!obj) continue;
    const id = asString(obj.id);
    const identifier = asString(obj.identifier);
    if (!id || !identifier) continue;
    out.push({ id, identifier });
  }
  return { ok: true, value: { nodes: out, hasNext: page.value.hasNext, endCursor: page.value.endCursor } };
}

function parseMinimalStatePage(data: unknown): TrackerResult<MinimalIssueState[]> {
  const root = asObject(data);
  const issues = root ? asObject(root.issues) : null;
  if (!issues) {
    return {
      ok: false,
      error: {
        code: 'linear_unknown_payload',
        message: 'response missing issues object',
      },
    };
  }
  const nodes = asArray(issues.nodes) ?? [];
  const out: MinimalIssueState[] = [];
  for (const node of nodes) {
    const obj = asObject(node);
    if (!obj) continue;
    const id = asString(obj.id);
    const identifier = asString(obj.identifier);
    const state = asObject(obj.state);
    const stateName = state ? asString(state.name) : null;
    if (!id || !identifier || !stateName) continue;
    out.push({ id, identifier, state: stateName });
  }
  return { ok: true, value: out };
}

function parseWorkflowStateLookup(data: unknown): TrackerResult<{ id: string; name: string }> {
  const root = asObject(data);
  const workflowStates = root ? asObject(root.workflowStates) : null;
  if (!workflowStates) {
    return {
      ok: false,
      error: { code: 'linear_unknown_payload', message: 'response missing workflowStates object' },
    };
  }
  const nodes = asArray(workflowStates.nodes) ?? [];
  for (const node of nodes) {
    const obj = asObject(node);
    if (!obj) continue;
    const id = asString(obj.id);
    const name = asString(obj.name);
    if (id && name) return { ok: true, value: { id, name } };
  }
  return {
    ok: false,
    error: { code: 'linear_unknown_payload', message: 'no matching workflow state returned' },
  };
}

function parseIssueStateUpdate(data: unknown): TrackerResult<{ state: string }> {
  const root = asObject(data);
  const issueUpdate = root ? asObject(root.issueUpdate) : null;
  const issue = issueUpdate ? asObject(issueUpdate.issue) : null;
  const state = issue ? asObject(issue.state) : null;
  const stateName = state ? asString(state.name) : null;
  if (!issueUpdate || !Boolean(issueUpdate.success) || !stateName) {
    return {
      ok: false,
      error: { code: 'linear_unknown_payload', message: 'issueUpdate did not return a successful state' },
    };
  }
  return { ok: true, value: { state: stateName } };
}

interface FileUploadSlot {
  uploadUrl: string;
  assetUrl: string;
  headers: Array<{ key: string; value: string }>;
}

function parseFileUpload(data: unknown): TrackerResult<FileUploadSlot> {
  const root = asObject(data);
  const upload = root ? asObject(root.fileUpload) : null;
  const file = upload ? asObject(upload.uploadFile) : null;
  if (!file) {
    return {
      ok: false,
      error: { code: 'linear_unknown_payload', message: 'fileUpload mutation returned no uploadFile' },
    };
  }
  const headersArr = asArray(file.headers) ?? [];
  const headers: Array<{ key: string; value: string }> = [];
  for (const h of headersArr) {
    const ho = asObject(h);
    if (!ho) continue;
    const k = asString(ho.key);
    const v = asString(ho.value);
    if (k && v) headers.push({ key: k, value: v });
  }
  return {
    ok: true,
    value: {
      uploadUrl: asString(file.uploadUrl) ?? '',
      assetUrl: asString(file.assetUrl) ?? '',
      headers,
    },
  };
}

function parseAttachment(data: unknown): TrackerResult<{ id: string | null; success: boolean }> {
  const root = asObject(data);
  const ac = root ? asObject(root.attachmentCreate) : null;
  const attachment = ac ? asObject(ac.attachment) : null;
  return {
    ok: true,
    value: {
      id: attachment ? asString(attachment.id) : null,
      success: ac ? Boolean(ac.success) : false,
    },
  };
}

function parseComment(data: unknown): TrackerResult<{ success: boolean }> {
  const root = asObject(data);
  const cc = root ? asObject(root.commentCreate) : null;
  return { ok: true, value: { success: cc ? Boolean(cc.success) : false } };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function normalizeFullIssue(node: unknown): Issue | null {
  const obj = asObject(node);
  if (!obj) return null;
  const id = asString(obj.id);
  const identifier = asString(obj.identifier);
  const title = asString(obj.title);
  const stateObj = asObject(obj.state);
  const stateName = stateObj ? asString(stateObj.name) : null;
  if (!id || !identifier || !title || !stateName) return null;

  const description = asString(obj.description);
  const branchName = asString(obj.branchName);
  const url = asString(obj.url);
  const createdAt = asString(obj.createdAt);
  const updatedAt = asString(obj.updatedAt);
  const priority =
    typeof obj.priority === 'number' && Number.isFinite(obj.priority) && Number.isInteger(obj.priority)
      ? obj.priority
      : null;
  const assigneeObj = asObject(obj.assignee);
  const assigneeId = assigneeObj ? asString(assigneeObj.id) : null;
  const assigneeName = assigneeObj ? asString(assigneeObj.name) : null;

  const labelsContainer = asObject(obj.labels);
  const labelNodes = labelsContainer ? asArray(labelsContainer.nodes) ?? [] : [];
  const labels: string[] = [];
  for (const labelNode of labelNodes) {
    const labelObj = asObject(labelNode);
    const labelName = labelObj ? asString(labelObj.name) : null;
    if (labelName) labels.push(labelName.toLowerCase());
  }

  const blockers: BlockerRef[] = [];
  const relsContainer = asObject(obj.inverseRelations);
  const relNodes = relsContainer ? asArray(relsContainer.nodes) ?? [] : [];
  for (const relNode of relNodes) {
    const relObj = asObject(relNode);
    if (!relObj) continue;
    const type = asString(relObj.type);
    if (type !== 'blocks') continue;
    const issueObj = asObject(relObj.issue);
    if (!issueObj) continue;
    const blockerStateObj = asObject(issueObj.state);
    blockers.push({
      id: asString(issueObj.id),
      identifier: asString(issueObj.identifier),
      state: blockerStateObj ? asString(blockerStateObj.name) : null,
    });
  }

  return {
    id,
    identifier,
    title,
    description,
    priority,
    state: stateName,
    branch_name: branchName,
    url,
    labels,
    assignee_id: assigneeId,
    assignee_name: assigneeName,
    blocked_by: blockers,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

import type { LinearAssigneeConfig, SupervisedProfile } from '../profile/types.js';
import type { ReadinessResult } from '../run/preflight.js';

export interface LinearIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  url: string;
  status: string;
  labels: string[];
  assigneeId: string | null;
  teamKey: string | null;
  projectName: string | null;
  comments: string[];
}

export interface StatusVerification {
  ok: boolean;
  missing: string[];
}

export interface AssigneeVerification {
  ok: boolean;
  assigneeId: string | null;
}

export interface ClaimIssueOptions {
  issueId: string;
  profile: SupervisedProfile;
  assigneeId: string;
}

export interface LinearReadAdapterOptions {
  endpoint?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';

export class LinearReadAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LinearReadAdapterOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.apiKey = opts.apiKey ?? process.env.LINEAR_API_KEY ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async findEligibleIssues(profile: SupervisedProfile): Promise<LinearIssue[]> {
    const data = await this.graphql<{ issues?: { nodes?: unknown[] } }>(ISSUES_QUERY, { filter: buildEligibleFilter(profile) });
    return normalizeIssues(data.issues?.nodes ?? [], profile);
  }

  async getIssueByKey(key: string, profile: SupervisedProfile): Promise<LinearIssue | null> {
    const data = await this.graphql<{ issue?: unknown }>(ISSUE_BY_ID_QUERY, { id: key });
    const issue = normalizeIssue(data.issue, profile);
    return issue && isEligibleIssue(issue, profile) ? issue : null;
  }

  async getIssueById(id: string, profile: SupervisedProfile): Promise<LinearIssue | null> {
    const data = await this.graphql<{ issue?: unknown }>(ISSUE_BY_ID_QUERY, { id });
    return normalizeIssue(data.issue, profile);
  }

  async verifyStatuses(profile: SupervisedProfile): Promise<StatusVerification> {
    const required = [profile.linear.eligible_status, profile.linear.claim_status, profile.linear.success_status];
    if (profile.linear.failure_status) required.push(profile.linear.failure_status);
    const data = await this.graphql<{ workflowStates?: { nodes?: Array<{ name?: string }> } }>(STATUSES_QUERY, { teamKey: profile.linear.team });
    const found = new Set((data.workflowStates?.nodes ?? []).map((node) => node.name).filter((name): name is string => typeof name === 'string'));
    const missing = required.filter((name) => !found.has(name));
    return { ok: missing.length === 0, missing };
  }

  async verifyAssignee(profile: SupervisedProfile): Promise<AssigneeVerification> {
    if (profile.linear.assignee.mode === 'authenticated_user') {
      const data = await this.graphql<{ viewer?: { id?: string } }>(VIEWER_QUERY, {});
      return { ok: typeof data.viewer?.id === 'string', assigneeId: data.viewer?.id ?? null };
    }
    const data = await this.graphql<{ user?: { id?: string } }>(USER_QUERY, { id: profile.linear.assignee.user_id });
    return { ok: data.user?.id === profile.linear.assignee.user_id, assigneeId: data.user?.id ?? null };
  }

  async checkAuth(profile: SupervisedProfile): Promise<ReadinessResult> {
    try {
      const verified = await this.verifyAssignee(profile);
      return verified.ok ? { ok: true } : { ok: false, reason: 'Linear viewer/assignee could not be resolved' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkStatus(statusName: string, profile: SupervisedProfile): Promise<ReadinessResult> {
    try {
      await this.resolveStatusId(profile, statusName);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async checkAssignee(_assignee: LinearAssigneeConfig, profile: SupervisedProfile): Promise<ReadinessResult> {
    try {
      const verified = await this.verifyAssignee(profile);
      return verified.ok ? { ok: true } : { ok: false, reason: 'Linear assignee could not be resolved' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async resolveAssigneeId(profile: SupervisedProfile): Promise<string> {
    const verified = await this.verifyAssignee(profile);
    if (!verified.ok || !verified.assigneeId) throw new Error('Linear assignee could not be resolved');
    return verified.assigneeId;
  }

  async resolveStatusId(profile: SupervisedProfile, statusName: string): Promise<string> {
    const data = await this.graphql<{ workflowStates?: { nodes?: Array<{ id?: string; name?: string }> } }>(STATUSES_WITH_IDS_QUERY, { teamKey: profile.linear.team });
    const match = (data.workflowStates?.nodes ?? []).find((node) => node.name === statusName && typeof node.id === 'string');
    if (!match?.id) throw new Error(`Linear status not found: ${statusName}`);
    return match.id;
  }

  async claimIssue(opts: ClaimIssueOptions): Promise<void> {
    const stateId = await this.resolveStatusId(opts.profile, opts.profile.linear.claim_status);
    const data = await this.graphql<{ issueUpdate?: { success?: boolean } }>(ISSUE_UPDATE_MUTATION, {
      id: opts.issueId,
      input: { stateId, assigneeId: opts.assigneeId },
    });
    if (data.issueUpdate?.success !== true) throw new Error(`Linear issue claim failed for ${opts.issueId}`);
  }

  async updateIssueStatus(opts: { issueId: string; profile: SupervisedProfile; statusName: string }): Promise<void> {
    const stateId = await this.resolveStatusId(opts.profile, opts.statusName);
    const data = await this.graphql<{ issueUpdate?: { success?: boolean } }>(ISSUE_UPDATE_MUTATION, {
      id: opts.issueId,
      input: { stateId },
    });
    if (data.issueUpdate?.success !== true) throw new Error(`Linear issue status update failed for ${opts.issueId}`);
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const data = await this.graphql<{ commentCreate?: { success?: boolean } }>(COMMENT_CREATE_MUTATION, { issueId, body });
    if (data.commentCreate?.success !== true) throw new Error(`Linear comment creation failed for ${issueId}`);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error('Linear API key not configured');
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Linear GraphQL request failed: HTTP ${response.status}`);
    const json = (await response.json()) as { data?: T; errors?: unknown[] };
    if (json.errors && json.errors.length > 0) throw new Error(`Linear GraphQL request failed: ${JSON.stringify(json.errors)}`);
    return (json.data ?? {}) as T;
  }
}

function buildEligibleFilter(profile: SupervisedProfile): Record<string, unknown> {
  const filter: Record<string, unknown> = { team: { key: { eq: profile.linear.team } }, state: { name: { eq: profile.linear.eligible_status } } };
  if (profile.linear.project) filter.project = { name: { eq: profile.linear.project } };
  if (profile.linear.require_unassigned) filter.assignee = { null: true };
  if (profile.linear.required_labels.length > 0) {
    filter.and = profile.linear.required_labels.map((label) => ({ labels: { some: { name: { eq: label } } } }));
  }
  return filter;
}

function normalizeIssues(nodes: unknown[], profile: SupervisedProfile | null): LinearIssue[] {
  return nodes.map((node) => normalizeIssue(node, profile)).filter((issue): issue is LinearIssue => issue !== null);
}

function isEligibleIssue(issue: LinearIssue, profile: SupervisedProfile): boolean {
  if (issue.teamKey !== profile.linear.team) return false;
  if (issue.status !== profile.linear.eligible_status) return false;
  if (profile.linear.project && issue.projectName !== profile.linear.project) return false;
  if (profile.linear.require_unassigned && issue.assigneeId !== null) return false;
  return profile.linear.required_labels.every((label) => issue.labels.includes(label));
}

function normalizeIssue(node: unknown, profile: SupervisedProfile | null): LinearIssue | null {
  if (!isRecord(node)) return null;
  const id = stringValue(node.id);
  const key = stringValue(node.identifier);
  const title = stringValue(node.title);
  if (!id || !key || !title) return null;
  const labels = nodesOf(node.labels).map((label) => stringValue(label.name)).filter((name): name is string => Boolean(name));
  const rawComments = profile?.linear.include_comments === false ? [] : nodesOf(node.comments).map((comment) => stringValue(comment.body) ?? '').filter(Boolean);
  const maxComments = profile?.linear.max_comments ?? rawComments.length;
  const orderedComments = profile?.linear.comment_order === 'reverse_chronological' ? [...rawComments].reverse() : rawComments;
  return {
    id,
    key,
    title,
    description: stringValue(node.description) ?? '',
    url: stringValue(node.url) ?? '',
    status: isRecord(node.state) ? stringValue(node.state.name) ?? '' : '',
    labels,
    assigneeId: isRecord(node.assignee) ? stringValue(node.assignee.id) : null,
    teamKey: isRecord(node.team) ? stringValue(node.team.key) : null,
    projectName: isRecord(node.project) ? stringValue(node.project.name) : null,
    comments: orderedComments.slice(0, maxComments).map((comment) => truncate(comment, profile?.linear.comment_max_chars ?? comment.length)),
  };
}

function nodesOf(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  return value.nodes.filter(isRecord);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars))}\n[TRUNCATED]`;
}

const ISSUE_FIELDS = `id identifier title description url state { name } assignee { id } team { key } project { name } labels { nodes { name } } comments { nodes { body } }`;
const ISSUES_QUERY = `query SymphonySupervisedIssues($filter: IssueFilter!) { issues(filter: $filter) { nodes { ${ISSUE_FIELDS} } } }`;
const STATUSES_QUERY = `query SymphonySupervisedStatuses($teamKey: String!) { workflowStates(filter: { team: { key: { eq: $teamKey } } }) { nodes { name } } }`;
const STATUSES_WITH_IDS_QUERY = `query SymphonySupervisedStatusesWithIds($teamKey: String!) { workflowStates(filter: { team: { key: { eq: $teamKey } } }) { nodes { id name } } }`;
const VIEWER_QUERY = `query SymphonySupervisedViewer { viewer { id name } }`;
const USER_QUERY = `query SymphonySupervisedUser($id: String!) { user(id: $id) { id name } }`;
const ISSUE_BY_ID_QUERY = `query SymphonySupervisedIssueById($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
const ISSUE_UPDATE_MUTATION = `mutation SymphonySupervisedClaimIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`;
const COMMENT_CREATE_MUTATION = `mutation SymphonySupervisedComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }`;

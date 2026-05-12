import type { Issue } from '../workflow/types.js';

export type TrackerError =
  | { code: 'unsupported_tracker_kind'; kind: string; message: string }
  | { code: 'missing_tracker_api_key'; message: string }
  | { code: 'missing_tracker_project_slug'; message: string }
  | { code: 'linear_api_request'; message: string }
  | { code: 'linear_api_status'; status: number; body: string; message: string }
  | { code: 'linear_graphql_errors'; errors: unknown[]; message: string }
  | { code: 'linear_unknown_payload'; message: string }
  | { code: 'linear_missing_end_cursor'; message: string };

export type TrackerResult<T> = { ok: true; value: T } | { ok: false; error: TrackerError };

export interface MinimalIssueState {
  id: string;
  identifier: string;
  state: string;
}

export interface ArtifactUpload {
  /** Local file path to read bytes from. */
  path: string;
  /** Filename to advertise on the tracker side. */
  filename: string;
  /** Best-effort MIME type for the upload. */
  contentType: string;
}

export interface AttachmentResult {
  /** Tracker-internal id, when available. */
  id: string | null;
  /** Public URL where the artifact was stored. */
  url: string;
  /** Whether the tracker also rendered an inline preview (e.g. comment). */
  commented: boolean;
}

export interface TrackerClient {
  fetch_candidate_issues(): Promise<TrackerResult<Issue[]>>;
  fetch_issues_by_states(state_names: string[]): Promise<TrackerResult<Pick<Issue, 'id' | 'identifier'>[]>>;
  fetch_issue_states_by_ids(issue_ids: string[]): Promise<TrackerResult<MinimalIssueState[]>>;
  /** Move an issue to a named workflow state. Optional for read-only trackers. */
  update_issue_state?(issueId: string, stateName: string): Promise<TrackerResult<{ state: string }>>;
  /**
   * Upload an artifact (video, screenshot, log) to the tracker and surface it
   * on the issue. Optional — trackers without write support return undefined.
   */
  upload_attachment?(
    issueId: string,
    issueIdentifier: string,
    artifact: ArtifactUpload,
  ): Promise<TrackerResult<AttachmentResult>>;
}

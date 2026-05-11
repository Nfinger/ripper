/**
 * Domain types per Symphony spec sections 4 and 5.
 */

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string | null;
  /** Atlassian account email — required when `kind == "jira"` (Basic auth). */
  email: string | null;
  /** Linear team key (the prefix that appears in identifiers — e.g. `MFL` for `MFL-30`). */
  team_key: string | null;
  /**
   * For Linear: optional project slugId narrowing the team feed.
   * For Jira:   the project key (e.g. `TH` for TimeHawk).
   */
  project_slug: string | null;
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_retry_attempts: number;
  max_total_tokens_per_daemon: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export type AgentRuntimeKind = 'claude' | 'codex';

/**
 * Pluggable coding-agent runtime config. The legacy `claude` block is still
 * accepted by the config loader, but new workflows should use `agent_runtime`.
 */
export interface AgentRuntimeConfig {
  kind: AgentRuntimeKind;
  command: string;
  permission_mode: string | null;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

/** Legacy alias retained for compatibility with existing tests/callers. */
export type ClaudeConfig = AgentRuntimeConfig;

export interface ServerConfig {
  port: number | null;
  bind_host: string;
}

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  agent_runtime: AgentRuntimeConfig;
  /** Legacy alias for agent_runtime, retained for old consumers. */
  claude: ClaudeConfig;
  server: ServerConfig;
  prompt_template: string;
}

export type ValidationError =
  | { code: 'missing_workflow_file'; path: string; message: string }
  | { code: 'workflow_parse_error'; message: string }
  | { code: 'workflow_front_matter_not_a_map'; message: string }
  | { code: 'unsupported_tracker_kind'; kind: string; message: string }
  | { code: 'missing_tracker_api_key'; message: string }
  | { code: 'missing_tracker_project_slug'; message: string }
  | { code: 'missing_tracker_scope'; message: string }
  | { code: 'missing_agent_runtime_command'; message: string }
  | { code: 'missing_claude_command'; message: string }
  | { code: 'invalid_config_value'; field: string; message: string };

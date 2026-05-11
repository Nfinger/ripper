import os from 'node:os';
import path from 'node:path';

import type {
  AgentConfig,
  AgentRuntimeConfig,
  AgentRuntimeKind,
  ClaudeConfig,
  HooksConfig,
  PollingConfig,
  ServerConfig,
  ServiceConfig,
  TrackerConfig,
  ValidationError,
  WorkflowDefinition,
  WorkspaceConfig,
} from './types.js';

const DEFAULT_FALLBACK_PROMPT = 'You are working on an issue from Linear.';

const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_LINEAR_API_KEY_VAR = '$LINEAR_API_KEY';
const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'];
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 1;
const DEFAULT_MAX_TOTAL_TOKENS_PER_DAEMON = 200_000;

const DEFAULT_CLAUDE_COMMAND = 'claude -p --output-format stream-json --verbose';
const DEFAULT_CODEX_COMMAND = 'codex exec --json --sandbox workspace-write -m gpt-5.5';
const DEFAULT_AGENT_RUNTIME_KIND: AgentRuntimeKind = 'claude';
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;

const DEFAULT_BIND_HOST = '127.0.0.1';

const SUPPORTED_TRACKER_KINDS = new Set(['linear', 'jira']);
const ENV_INDIRECTION = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

const DEFAULT_JIRA_ACTIVE_STATES = ['To Do', 'In Progress'];
const DEFAULT_JIRA_TERMINAL_STATES = ['Done', 'Cancelled', 'Closed'];

function defaultActiveStatesFor(kind: string): string[] {
  return kind === 'jira' ? [...DEFAULT_JIRA_ACTIVE_STATES] : [...DEFAULT_ACTIVE_STATES];
}

function defaultTerminalStatesFor(kind: string): string[] {
  return kind === 'jira' ? [...DEFAULT_JIRA_TERMINAL_STATES] : [...DEFAULT_TERMINAL_STATES];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return value;
  return null;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function asAgentRuntimeKind(value: unknown): AgentRuntimeKind | null {
  if (value === 'claude' || value === 'codex') return value;
  return null;
}

/**
 * If value is exactly `$VAR_NAME`, look up the env var. Empty/missing → null.
 * Otherwise return the input unchanged. Spec §5.3.1, §6.1.
 */
export function resolveEnvIndirection(value: string | null): string | null {
  if (value === null) return null;
  const m = value.match(ENV_INDIRECTION);
  if (!m) return value;
  const envValue = process.env[m[1]!];
  if (!envValue) return null;
  return envValue;
}

/**
 * Expand a path-like string per spec §6.1: inline `$VAR` substitution, leading
 * `~` home expansion, then resolve relative paths against `baseDir`.
 */
export function expandPath(value: string, baseDir: string): string {
  let s = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? '');
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  if (!path.isAbsolute(s)) s = path.resolve(baseDir, s);
  return path.normalize(s);
}

/**
 * Build a typed ServiceConfig from a parsed WorkflowDefinition. Applies defaults,
 * does $VAR + ~ resolution, and resolves the workflow file's directory for
 * relative paths.
 *
 * Validation lives in `validateForDispatch` per spec §6.3 — this function is
 * purely a typed view and never throws.
 */
export function buildServiceConfig(
  workflow: WorkflowDefinition,
  workflowPath: string,
): ServiceConfig {
  const root = workflow.config;
  const workflowDir = path.dirname(path.resolve(workflowPath));

  const trackerRaw = asObject(root.tracker);
  const trackerKind = (asString(trackerRaw.kind) ?? '').toLowerCase();
  const trackerEndpoint =
    asString(trackerRaw.endpoint) ?? (trackerKind === 'linear' ? DEFAULT_LINEAR_ENDPOINT : '');
  const trackerApiKey = resolveEnvIndirection(
    asString(trackerRaw.api_key) ?? (trackerKind === 'linear' ? DEFAULT_LINEAR_API_KEY_VAR : null),
  );
  const trackerProjectSlug = asString(trackerRaw.project_slug);
  const trackerTeamKey = asString(trackerRaw.team_key);
  const trackerEmail = resolveEnvIndirection(asString(trackerRaw.email));
  const trackerTerminalStates =
    asStringList(trackerRaw.terminal_states) ?? defaultTerminalStatesFor(trackerKind);
  const trackerActiveStates =
    asStringList(trackerRaw.active_states) ?? defaultActiveStatesFor(trackerKind);
  const tracker: TrackerConfig = {
    kind: trackerKind,
    endpoint: trackerEndpoint,
    api_key: trackerApiKey,
    email: trackerEmail,
    team_key: trackerTeamKey,
    project_slug: trackerProjectSlug,
    active_states: trackerActiveStates,
    terminal_states: trackerTerminalStates,
  };

  const pollingRaw = asObject(root.polling);
  const polling: PollingConfig = {
    interval_ms: asInt(pollingRaw.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
  };

  const workspaceRaw = asObject(root.workspace);
  const workspaceRootInput =
    asString(workspaceRaw.root) ?? path.join(os.tmpdir(), 'symphony_workspaces');
  const workspace: WorkspaceConfig = {
    root: expandPath(workspaceRootInput, workflowDir),
  };

  const hooksRaw = asObject(root.hooks);
  const hooks: HooksConfig = {
    after_create: asString(hooksRaw.after_create),
    before_run: asString(hooksRaw.before_run),
    after_run: asString(hooksRaw.after_run),
    before_remove: asString(hooksRaw.before_remove),
    timeout_ms: asInt(hooksRaw.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
  };

  const agentRaw = asObject(root.agent);
  const byStateRaw = asObject(agentRaw.max_concurrent_agents_by_state);
  const byState: Record<string, number> = {};
  for (const [stateName, raw] of Object.entries(byStateRaw)) {
    const n = asInt(raw);
    if (n !== null && n > 0) byState[stateName.toLowerCase()] = n;
  }
  const agent: AgentConfig = {
    max_concurrent_agents: asInt(agentRaw.max_concurrent_agents) ?? DEFAULT_MAX_CONCURRENT_AGENTS,
    max_turns: asInt(agentRaw.max_turns) ?? DEFAULT_MAX_TURNS,
    max_retry_backoff_ms: asInt(agentRaw.max_retry_backoff_ms) ?? DEFAULT_MAX_RETRY_BACKOFF_MS,
    max_retry_attempts: asInt(agentRaw.max_retry_attempts) ?? DEFAULT_MAX_RETRY_ATTEMPTS,
    max_total_tokens_per_daemon:
      asInt(agentRaw.max_total_tokens_per_daemon) ?? DEFAULT_MAX_TOTAL_TOKENS_PER_DAEMON,
    max_concurrent_agents_by_state: byState,
  };

  const claudeRaw = asObject(root.claude);
  const runtimeRaw = asObject(root.agent_runtime);
  const runtimeKind = asAgentRuntimeKind(runtimeRaw.kind) ?? DEFAULT_AGENT_RUNTIME_KIND;
  const defaultCommand = runtimeKind === 'codex' ? DEFAULT_CODEX_COMMAND : DEFAULT_CLAUDE_COMMAND;
  const agentRuntime: AgentRuntimeConfig = {
    kind: runtimeKind,
    command: asString(runtimeRaw.command) ?? asString(claudeRaw.command) ?? defaultCommand,
    permission_mode: asString(runtimeRaw.permission_mode) ?? asString(claudeRaw.permission_mode),
    turn_timeout_ms:
      asInt(runtimeRaw.turn_timeout_ms) ?? asInt(claudeRaw.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
    read_timeout_ms:
      asInt(runtimeRaw.read_timeout_ms) ?? asInt(claudeRaw.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
    stall_timeout_ms:
      asInt(runtimeRaw.stall_timeout_ms) ?? asInt(claudeRaw.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
  };
  const claude: ClaudeConfig = agentRuntime;

  const serverRaw = asObject(root.server);
  const server: ServerConfig = {
    port: asInt(serverRaw.port),
    bind_host: asString(serverRaw.bind_host) ?? DEFAULT_BIND_HOST,
  };

  const promptTemplate =
    workflow.prompt_template.length > 0 ? workflow.prompt_template : DEFAULT_FALLBACK_PROMPT;

  return {
    workflow_path: path.resolve(workflowPath),
    workflow_dir: workflowDir,
    tracker,
    polling,
    workspace,
    hooks,
    agent,
    agent_runtime: agentRuntime,
    claude,
    server,
    prompt_template: promptTemplate,
  };
}

/**
 * Spec §6.3 dispatch preflight validation. Returns `null` when valid.
 * Used at startup AND before every dispatch tick.
 */
export function validateForDispatch(config: ServiceConfig): ValidationError | null {
  if (!config.tracker.kind) {
    return {
      code: 'unsupported_tracker_kind',
      kind: '',
      message: 'tracker.kind is required (currently supported: "linear")',
    };
  }
  if (!SUPPORTED_TRACKER_KINDS.has(config.tracker.kind)) {
    return {
      code: 'unsupported_tracker_kind',
      kind: config.tracker.kind,
      message: `tracker.kind "${config.tracker.kind}" is not supported; expected one of: ${[...SUPPORTED_TRACKER_KINDS].join(', ')}`,
    };
  }
  if (!config.tracker.api_key) {
    return {
      code: 'missing_tracker_api_key',
      message: `tracker.api_key is required (canonical env: LINEAR_API_KEY)`,
    };
  }
  if (
    config.tracker.kind === 'linear' &&
    !config.tracker.project_slug &&
    !config.tracker.team_key
  ) {
    return {
      code: 'missing_tracker_scope',
      message:
        'For tracker.kind == "linear", set at least one of tracker.team_key (e.g. "MFL") or tracker.project_slug',
    };
  }
  if (config.tracker.kind === 'jira') {
    if (!config.tracker.endpoint) {
      return {
        code: 'invalid_config_value',
        field: 'tracker.endpoint',
        message:
          'tracker.endpoint is required for kind=jira (e.g. https://yoursite.atlassian.net)',
      };
    }
    if (!config.tracker.email) {
      return {
        code: 'invalid_config_value',
        field: 'tracker.email',
        message: 'tracker.email is required for kind=jira (Atlassian account email)',
      };
    }
    if (!config.tracker.project_slug) {
      return {
        code: 'missing_tracker_project_slug',
        message: 'tracker.project_slug is required for kind=jira (the Jira project key, e.g. "TH")',
      };
    }
  }
  if (!config.agent_runtime.command || config.agent_runtime.command.trim().length === 0) {
    return {
      code: 'missing_agent_runtime_command',
      message: 'agent_runtime.command must be a non-empty shell command',
    };
  }
  if (config.hooks.timeout_ms <= 0) {
    return {
      code: 'invalid_config_value',
      field: 'hooks.timeout_ms',
      message: 'hooks.timeout_ms must be > 0',
    };
  }
  if (config.agent.max_turns <= 0) {
    return {
      code: 'invalid_config_value',
      field: 'agent.max_turns',
      message: 'agent.max_turns must be > 0',
    };
  }
  return null;
}

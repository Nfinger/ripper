import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServiceConfig, expandPath, resolveEnvIndirection, validateForDispatch } from '../src/workflow/config.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveEnvIndirection', () => {
  it('returns null when value is null', () => {
    expect(resolveEnvIndirection(null)).toBeNull();
  });

  it('returns the value unchanged when not exactly $VAR', () => {
    expect(resolveEnvIndirection('plain-token')).toBe('plain-token');
    expect(resolveEnvIndirection('lin_api_xxx')).toBe('lin_api_xxx');
    expect(resolveEnvIndirection('$NOT-A-VAR')).toBe('$NOT-A-VAR');
  });

  it('resolves $VAR from env', () => {
    process.env.SYM_TEST_TOKEN = 'abc123';
    expect(resolveEnvIndirection('$SYM_TEST_TOKEN')).toBe('abc123');
  });

  it('returns null when $VAR resolves to empty', () => {
    process.env.SYM_TEST_EMPTY = '';
    expect(resolveEnvIndirection('$SYM_TEST_EMPTY')).toBeNull();
  });

  it('returns null when $VAR is undefined', () => {
    delete process.env.SYM_TEST_MISSING;
    expect(resolveEnvIndirection('$SYM_TEST_MISSING')).toBeNull();
  });
});

describe('expandPath', () => {
  it('expands ~ to home dir', () => {
    const out = expandPath('~/foo', '/cwd');
    expect(out).toBe(path.join(os.homedir(), 'foo'));
  });

  it('expands inline $VAR', () => {
    process.env.SYM_TEST_BASE = '/var/sym';
    expect(expandPath('$SYM_TEST_BASE/work', '/cwd')).toBe('/var/sym/work');
  });

  it('resolves relative paths against baseDir', () => {
    expect(expandPath('workspaces', '/etc/sym')).toBe('/etc/sym/workspaces');
  });

  it('leaves absolute paths absolute', () => {
    expect(expandPath('/tmp/sym', '/cwd')).toBe('/tmp/sym');
  });
});

describe('buildServiceConfig', () => {
  it('applies defaults for an empty config', () => {
    const cfg = buildServiceConfig({ config: {}, prompt_template: '' }, '/work/WORKFLOW.md');
    expect(cfg.workflow_path).toBe('/work/WORKFLOW.md');
    expect(cfg.workflow_dir).toBe('/work');
    expect(cfg.tracker.kind).toBe('');
    expect(cfg.tracker.endpoint).toBe('');
    expect(cfg.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(cfg.tracker.terminal_states).toEqual(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']);
    expect(cfg.polling.interval_ms).toBe(30_000);
    expect(cfg.hooks.timeout_ms).toBe(60_000);
    expect(cfg.agent.max_concurrent_agents).toBe(10);
    expect(cfg.agent.max_turns).toBe(20);
    expect(cfg.agent.max_retry_backoff_ms).toBe(300_000);
    expect(cfg.agent.max_concurrent_agents_by_state).toEqual({});
    expect(cfg.agent_runtime.kind).toBe('claude');
    expect(cfg.agent_runtime.command).toContain('claude');
    expect(cfg.agent_runtime.turn_timeout_ms).toBe(3_600_000);
    expect(cfg.agent_runtime.stall_timeout_ms).toBe(300_000);
    expect(cfg.claude.command).toContain('claude');
    expect(cfg.claude.turn_timeout_ms).toBe(3_600_000);
    expect(cfg.claude.stall_timeout_ms).toBe(300_000);
    expect(cfg.server.port).toBeNull();
    expect(cfg.server.bind_host).toBe('127.0.0.1');
    expect(cfg.prompt_template).toBe('You are working on an issue from Linear.');
  });

  it('uses the linear endpoint default when kind=linear', () => {
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'linear' } }, prompt_template: 'p' },
      '/x/WORKFLOW.md',
    );
    expect(cfg.tracker.endpoint).toBe('https://api.linear.app/graphql');
  });

  it('resolves tracker api key from $LINEAR_API_KEY by default', () => {
    process.env.LINEAR_API_KEY = 'lin_api_default';
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'linear' } }, prompt_template: '' },
      '/x/WORKFLOW.md',
    );
    expect(cfg.tracker.api_key).toBe('lin_api_default');
  });

  it('resolves explicit $VAR for api_key', () => {
    process.env.MY_LINEAR_KEY = 'override-key';
    const cfg = buildServiceConfig(
      {
        config: { tracker: { kind: 'linear', api_key: '$MY_LINEAR_KEY' } },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(cfg.tracker.api_key).toBe('override-key');
  });

  it('preserves a literal api_key', () => {
    const cfg = buildServiceConfig(
      {
        config: { tracker: { kind: 'linear', api_key: 'literal-token' } },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(cfg.tracker.api_key).toBe('literal-token');
  });

  it('resolves relative workspace.root against the workflow dir', () => {
    const cfg = buildServiceConfig(
      { config: { workspace: { root: 'work' } }, prompt_template: '' },
      '/etc/sym/WORKFLOW.md',
    );
    expect(cfg.workspace.root).toBe('/etc/sym/work');
  });

  it('expands ~ in workspace.root', () => {
    const cfg = buildServiceConfig(
      { config: { workspace: { root: '~/symwork' } }, prompt_template: '' },
      '/x/WORKFLOW.md',
    );
    expect(cfg.workspace.root).toBe(path.join(os.homedir(), 'symwork'));
  });

  it('keeps agent_runtime.command as a raw shell string and does NOT expand inside it', () => {
    const cfg = buildServiceConfig(
      {
        config: { agent_runtime: { kind: 'codex', command: 'codex exec --json --sandbox workspace-write -m $SHOULD_NOT_RESOLVE' } },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(cfg.agent_runtime.kind).toBe('codex');
    expect(cfg.agent_runtime.command).toBe('codex exec --json --sandbox workspace-write -m $SHOULD_NOT_RESOLVE');
  });

  it('normalizes per-state concurrency map (lowercase keys, drops invalid values)', () => {
    const cfg = buildServiceConfig(
      {
        config: {
          agent: {
            max_concurrent_agents_by_state: {
              'In Progress': 3,
              Todo: 5,
              BadValue: -1,
              NotANumber: 'two',
            },
          },
        },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(cfg.agent.max_concurrent_agents_by_state).toEqual({
      'in progress': 3,
      todo: 5,
    });
  });
});

describe('validateForDispatch', () => {
  function base() {
    process.env.LINEAR_API_KEY = 'k';
    return buildServiceConfig(
      {
        config: { tracker: { kind: 'linear', project_slug: 'market-savvy' } },
        prompt_template: 'go',
      },
      '/x/WORKFLOW.md',
    );
  }

  it('passes a fully configured workflow', () => {
    expect(validateForDispatch(base())).toBeNull();
  });

  it('errors on missing tracker kind', () => {
    const cfg = buildServiceConfig({ config: {}, prompt_template: '' }, '/x/WORKFLOW.md');
    expect(validateForDispatch(cfg)?.code).toBe('unsupported_tracker_kind');
  });

  it('errors on unsupported tracker kind', () => {
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'asana' } }, prompt_template: '' },
      '/x/WORKFLOW.md',
    );
    expect(validateForDispatch(cfg)?.code).toBe('unsupported_tracker_kind');
  });

  it('errors when api_key is unresolved', () => {
    delete process.env.LINEAR_API_KEY;
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'linear', project_slug: 'x' } }, prompt_template: '' },
      '/x/WORKFLOW.md',
    );
    expect(validateForDispatch(cfg)?.code).toBe('missing_tracker_api_key');
  });

  it('errors when both project_slug and team_key are missing for linear', () => {
    process.env.LINEAR_API_KEY = 'k';
    const cfg = buildServiceConfig(
      { config: { tracker: { kind: 'linear' } }, prompt_template: '' },
      '/x/WORKFLOW.md',
    );
    expect(validateForDispatch(cfg)?.code).toBe('missing_tracker_scope');
  });

  it('passes when only team_key is set (no project)', () => {
    process.env.LINEAR_API_KEY = 'k';
    const cfg = buildServiceConfig(
      {
        config: { tracker: { kind: 'linear', team_key: 'MFL' } },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(validateForDispatch(cfg)).toBeNull();
  });

  it('errors when agent_runtime.command is empty', () => {
    process.env.LINEAR_API_KEY='***';
    const cfg = buildServiceConfig(
      {
        config: {
          tracker: { kind: 'linear', project_slug: 'x' },
          agent_runtime: { kind: 'codex', command: '   ' },
        },
        prompt_template: '',
      },
      '/x/WORKFLOW.md',
    );
    expect(validateForDispatch(cfg)?.code).toBe('missing_agent_runtime_command');
  });
});

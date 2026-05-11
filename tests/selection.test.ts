import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_DELAY_MS,
  computeAvailableSlots,
  computeBackoffMs,
  isEligible,
  sortForDispatch,
} from '../src/orchestrator/selection.js';
import { createInitialState } from '../src/orchestrator/state.js';
import { buildServiceConfig } from '../src/workflow/config.js';
import type { Issue, ServiceConfig } from '../src/workflow/types.js';

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `MS-${id}`,
    title: `Issue ${id}`,
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ServiceConfig {
  process.env.LINEAR_API_KEY = 'k';
  return buildServiceConfig(
    {
      config: {
        tracker: { kind: 'linear', project_slug: 'market-savvy' },
        ...overrides,
      },
      prompt_template: 'p',
    },
    '/x/WORKFLOW.md',
  );
}

describe('computeBackoffMs', () => {
  it('exponential 10s base, attempt-1 power', () => {
    expect(computeBackoffMs(1, 1_000_000)).toBe(10_000);
    expect(computeBackoffMs(2, 1_000_000)).toBe(20_000);
    expect(computeBackoffMs(3, 1_000_000)).toBe(40_000);
    expect(computeBackoffMs(5, 1_000_000)).toBe(160_000);
  });
  it('caps at max', () => {
    expect(computeBackoffMs(20, 300_000)).toBe(300_000);
  });
  it('CONTINUATION_DELAY_MS is 1s per spec §8.4', () => {
    expect(CONTINUATION_DELAY_MS).toBe(1000);
  });
});

describe('sortForDispatch', () => {
  it('priority asc, null priority sorts last', () => {
    const sorted = sortForDispatch([
      issue('a', { priority: null }),
      issue('b', { priority: 1 }),
      issue('c', { priority: 3 }),
      issue('d', { priority: 2 }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('breaks priority ties by oldest created_at then identifier', () => {
    const sorted = sortForDispatch([
      issue('a', { priority: 2, created_at: '2026-04-10T00:00:00.000Z', identifier: 'MS-300' }),
      issue('b', { priority: 2, created_at: '2026-04-09T00:00:00.000Z', identifier: 'MS-301' }),
      issue('c', { priority: 2, created_at: '2026-04-09T00:00:00.000Z', identifier: 'MS-200' }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('isEligible', () => {
  it('rejects non-active states', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 2 });
    const config = makeConfig();
    const slots = computeAvailableSlots(state, config);
    expect(isEligible(issue('a', { state: 'Done' }), state, config, slots)).toBe(false);
  });

  it('rejects already-claimed issues', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 2 });
    state.claimed.add('a');
    const config = makeConfig();
    const slots = computeAvailableSlots(state, config);
    expect(isEligible(issue('a'), state, config, slots)).toBe(false);
  });

  it('rejects Todo with non-terminal blockers', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 2 });
    const config = makeConfig();
    const slots = computeAvailableSlots(state, config);
    const i = issue('a', {
      state: 'Todo',
      blocked_by: [{ id: 'x', identifier: 'X-1', state: 'In Progress' }],
    });
    expect(isEligible(i, state, config, slots)).toBe(false);
  });

  it('accepts Todo with terminal blockers', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 2 });
    const config = makeConfig();
    const slots = computeAvailableSlots(state, config);
    const i = issue('a', {
      state: 'Todo',
      blocked_by: [{ id: 'x', identifier: 'X-1', state: 'Done' }],
    });
    expect(isEligible(i, state, config, slots)).toBe(true);
  });

  it('honors per-state concurrency caps', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 5 });
    const config = makeConfig({
      agent: { max_concurrent_agents_by_state: { 'In Progress': 1 } },
    });
    state.running.set('x1', {
      issue_id: 'x1',
      identifier: 'X-1',
      issue: issue('x1', { state: 'In Progress' }),
      worker_promise: Promise.resolve({ kind: 'normal', turns: 0 }),
      abort: new AbortController(),
      retry_attempt: null,
      started_at: 0,
      turn_count: 0,
      thread_id: null,
      session_id: null,
      claude_pid: null,
      last_event: null,
      last_event_at: null,
      last_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
    });
    const slots = computeAvailableSlots(state, config);
    expect(isEligible(issue('y1', { state: 'In Progress' }), state, config, slots)).toBe(false);
    expect(isEligible(issue('y2', { state: 'Todo' }), state, config, slots)).toBe(true);
  });
});

describe('computeAvailableSlots', () => {
  it('reports 0 when running.size meets the cap', () => {
    const state = createInitialState({ poll_interval_ms: 30_000, max_concurrent_agents: 1 });
    state.running.set('x', {
      issue_id: 'x',
      identifier: 'X',
      issue: issue('x', { state: 'Todo' }),
      worker_promise: Promise.resolve({ kind: 'normal', turns: 0 }),
      abort: new AbortController(),
      retry_attempt: null,
      started_at: 0,
      turn_count: 0,
      thread_id: null,
      session_id: null,
      claude_pid: null,
      last_event: null,
      last_event_at: null,
      last_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
    });
    const slots = computeAvailableSlots(state, makeConfig());
    expect(slots.global_available).toBe(0);
  });
});

import { runCommand } from '../command-runner/runner.js';
import type { CommandResult, RunCommandOptions } from '../command-runner/types.js';
import type { RunReason } from '../run-record/types.js';
import type { ReadinessResult } from '../run/preflight.js';

export interface CreatePullRequestOptions {
  cwd: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface PostPullRequestCommentOptions {
  cwd: string;
  prUrl: string;
  body: string;
}

export interface GitHubCheckRun {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string;
  link?: string;
  workflow?: string;
}

export interface WaitForChecksOptions {
  cwd: string;
  prUrl: string;
  requiredOnly: boolean;
  explicitCheckNames?: string[];
  timeoutMs: number;
  intervalSeconds: number;
}

export type WaitForChecksResult =
  | { ok: true; checks: GitHubCheckRun[] }
  | { ok: false; reason: Extract<RunReason, 'ci_failed' | 'ci_timeout'>; checks: GitHubCheckRun[] };

export interface GitHubCliAdapterOptions {
  commandRunner?: (opts: RunCommandOptions) => Promise<CommandResult>;
}

export class GitHubCliAdapter {
  private readonly commandRunner: (opts: RunCommandOptions) => Promise<CommandResult>;

  constructor(opts: GitHubCliAdapterOptions = {}) {
    this.commandRunner = opts.commandRunner ?? runCommand;
  }

  async checkAuth(): Promise<ReadinessResult> {
    const result = await this.commandRunner({ mode: 'argv', command: 'gh', args: ['auth', 'status'], cwd: process.cwd(), timeoutMs: 30_000 });
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, reason: (result.stderr || result.stdout || 'gh auth status failed').trim() };
  }

  async createPullRequest(opts: CreatePullRequestOptions): Promise<PullRequestResult> {
    const createArgs = [
      'pr',
      'create',
      ...(opts.draft ? ['--draft'] : []),
      '--title',
      opts.title,
      '--body',
      opts.body,
      '--head',
      opts.head,
      '--base',
      opts.base,
    ];

    const create = await this.commandRunner({ mode: 'argv', command: 'gh', args: createArgs, cwd: opts.cwd, timeoutMs: 60_000 });
    if (create.exitCode !== 0) throw new Error(`gh pr create failed: ${create.stderr || create.stdout}`.trim());
    const url = parsePrUrl(create.stdout);
    if (!url) throw new Error('gh pr create did not return a pull request URL');

    const view = await this.commandRunner({ mode: 'argv', command: 'gh', args: ['pr', 'view', url, '--json', 'number,url'], cwd: opts.cwd, timeoutMs: 30_000 });
    const fallbackNumber = parsePrNumber(url);
    if (view.exitCode !== 0) {
      if (fallbackNumber !== null) return { number: fallbackNumber, url };
      throw new Error(`gh pr view failed: ${view.stderr || view.stdout}`.trim());
    }
    try {
      const parsed = JSON.parse(view.stdout) as { number?: unknown; url?: unknown };
      if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string') throw new Error('missing number/url');
      return { number: parsed.number, url: parsed.url };
    } catch (error) {
      if (fallbackNumber !== null) return { number: fallbackNumber, url };
      throw new Error(`gh pr view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async postPullRequestComment(opts: PostPullRequestCommentOptions): Promise<void> {
    const result = await this.commandRunner({ mode: 'argv', command: 'gh', args: ['pr', 'comment', opts.prUrl, '--body', opts.body], cwd: opts.cwd, timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(`gh pr comment failed: ${result.stderr || result.stdout}`.trim());
  }

  async waitForChecks(opts: WaitForChecksOptions): Promise<WaitForChecksResult> {
    if (opts.intervalSeconds > 0) await sleep(opts.intervalSeconds * 1000);
    const deadline = Date.now() + opts.timeoutMs;
    let lastChecks: GitHubCheckRun[] = [];

    while (Date.now() <= deadline) {
      const result = await this.runCheckSnapshotCommand(opts, Math.max(1, deadline - Date.now()));
      if (result.timedOut) return { ok: false, reason: 'ci_timeout', checks: lastChecks };
      if (result.exitCode !== 0) return { ok: false, reason: 'ci_failed', checks: lastChecks };

      const parsed = parseStatusCheckRollup(result.stdout);
      if (!parsed.ok) return { ok: false, reason: 'ci_failed', checks: lastChecks };

      const checks = applyExplicitCheckNames(parsed.checks, opts.explicitCheckNames ?? []);
      lastChecks = checks;
      const hasChecks = checks.length > 0;
      const anyFailing = checks.some((check) => check.bucket === 'fail' || check.bucket === 'cancel');
      const anyPending = checks.some((check) => check.bucket === 'pending');
      const allPassing = hasChecks && checks.every((check) => check.bucket === 'pass' || check.bucket === 'skipping');

      if (allPassing) return { ok: true, checks };
      if (hasChecks && anyFailing) return { ok: false, reason: 'ci_failed', checks };
      if (!hasChecks || anyPending) {
        await sleep(Math.max(0, opts.intervalSeconds) * 1000);
        continue;
      }

      return { ok: false, reason: 'ci_failed', checks };
    }

    return { ok: false, reason: 'ci_timeout', checks: lastChecks };
  }

  private async runCheckSnapshotCommand(opts: WaitForChecksOptions, timeoutMs: number): Promise<CommandResult> {
    return this.commandRunner({
      mode: 'argv',
      command: 'gh',
      args: ['pr', 'view', opts.prUrl, '--json', 'statusCheckRollup'],
      cwd: opts.cwd,
      timeoutMs,
    });
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStatusCheckRollup(stdout: string): { ok: true; checks: GitHubCheckRun[] } | { ok: false } {
  try {
    const parsed = JSON.parse(stdout) as { statusCheckRollup?: unknown };
    if (!Array.isArray(parsed.statusCheckRollup)) return { ok: false };
    return { ok: true, checks: parsed.statusCheckRollup
      .filter((check): check is Record<string, unknown> => typeof check === 'object' && check !== null && check.__typename === 'CheckRun')
      .map((check) => {
        const status = typeof check.status === 'string' ? check.status : '';
        const conclusion = typeof check.conclusion === 'string' ? check.conclusion : '';
        return {
          name: typeof check.name === 'string' ? check.name : 'unknown-check',
          state: conclusion || status || 'unknown',
          bucket: checkRunBucket(status, conclusion),
          ...(typeof check.detailsUrl === 'string' ? { link: check.detailsUrl } : {}),
          ...(typeof check.workflowName === 'string' ? { workflow: check.workflowName } : {}),
        };
      }) };
  } catch {
    return { ok: false };
  }
}

function checkRunBucket(status: string, conclusion: string): GitHubCheckRun['bucket'] {
  if (status !== 'COMPLETED') return 'pending';
  if (conclusion === 'SUCCESS') return 'pass';
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'skipping';
  if (conclusion === 'CANCELLED') return 'cancel';
  return 'fail';
}

function parseChecks(stdout: string): { ok: true; checks: GitHubCheckRun[] } | { ok: false } {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return { ok: false };
    return { ok: true, checks: parsed.map((check) => {
      const item = check as Record<string, unknown>;
      return {
        name: typeof item.name === 'string' ? item.name : 'unknown-check',
        state: typeof item.state === 'string' ? item.state : 'unknown',
        bucket: typeof item.bucket === 'string' ? item.bucket : 'unknown',
        ...(typeof item.link === 'string' ? { link: item.link } : {}),
        ...(typeof item.workflow === 'string' ? { workflow: item.workflow } : {}),
      };
    }) };
  } catch {
    return { ok: false };
  }
}

function applyExplicitCheckNames(checks: GitHubCheckRun[], explicitCheckNames: string[]): GitHubCheckRun[] {
  if (explicitCheckNames.length === 0) return checks;
  return explicitCheckNames.map((name) => checks.find((check) => check.name === name) ?? { name, state: 'missing', bucket: 'fail' });
}

function parsePrUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/\S+\/pull\/\d+/);
  return match?.[0] ?? null;
}

function parsePrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:\D|$)/);
  if (!match?.[1]) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

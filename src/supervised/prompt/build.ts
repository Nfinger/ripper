import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LinearIssue } from '../adapters/linear.js';
import type { SupervisedProfile } from '../profile/types.js';

export interface BuildPromptOptions {
  profile: SupervisedProfile;
  issue: LinearIssue;
  runId: string;
  dryRun: boolean;
  runDir?: string;
}

export interface BuildPromptResult {
  prompt: string;
  includedInstructionFiles: string[];
}

const DEFAULT_ALLOWED_INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md']);

export async function buildPrompt(opts: BuildPromptOptions): Promise<BuildPromptResult> {
  const instructionSections: string[] = [];
  const includedInstructionFiles: string[] = [];
  for (const fileName of opts.profile.prompt.include_repo_instruction_files) {
    if (!DEFAULT_ALLOWED_INSTRUCTION_FILES.has(fileName)) continue;
    const filePath = path.join(opts.profile.repo.path, fileName);
    try {
      const raw = await readFile(filePath, 'utf8');
      includedInstructionFiles.push(fileName);
      instructionSections.push(`### ${fileName}\n\n${truncate(raw, opts.profile.prompt.repo_instruction_max_chars)}`);
    } catch {
      // Missing instruction files are ignored; includedInstructionFiles records what was actually used.
    }
  }

  const sections = [
    '# Symphony Codex Implementation Prompt',
    opts.dryRun ? '**DRY RUN — NOT EXECUTED**' : null,
    `Run ID: ${opts.runId}`,
    '## Linear Issue',
    `Key/title: ${opts.issue.key}: ${opts.issue.title}`,
    `URL: ${opts.issue.url}`,
    `Status: ${opts.issue.status}`,
    `Labels: ${opts.issue.labels.join(', ') || '(none)'}`,
    '### Description',
    opts.issue.description || '(none)',
    '### Comments',
    opts.issue.comments.length > 0 ? opts.issue.comments.map((comment, index) => `#### Comment ${index + 1}\n${comment}`).join('\n\n') : '(none)',
    '## Repository',
    `Base branch: ${opts.profile.repo.base_branch}`,
    `Remote: ${opts.profile.repo.remote}`,
    '## Repo Instructions',
    instructionSections.length > 0 ? instructionSections.join('\n\n') : '(none)',
    opts.profile.prompt.extra_instructions ? `## Profile Extra Instructions\n${opts.profile.prompt.extra_instructions}` : null,
    '## Symphony DO NOT Rules',
    [
      '- do not create or push branches',
      '- do not open PRs',
      '- do not post GitHub or Linear comments',
      '- do not move Linear statuses',
      '- do not include secrets in code, commits, logs, or summaries',
      '- do not modify files outside the repo worktree',
      '- do not leave uncommitted changes',
      '- do not claim success without commits',
    ].join('\n'),
    '## Required Final Response Format',
    ['SUMMARY:', '- ...', '', 'FILES_CHANGED:', '- path: reason', '', 'VALIDATION_RUN:', '- command: result', '', 'RISKS:', '- ...'].join('\n'),
  ].filter((section): section is string => section !== null);

  let prompt = sections.join('\n\n');
  if (opts.runDir) prompt = prompt.split(opts.runDir).join('[RUN_DIR_REDACTED]');
  return { prompt, includedInstructionFiles };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars))}\n[TRUNCATED]`;
}

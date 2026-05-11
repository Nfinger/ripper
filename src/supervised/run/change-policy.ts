import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile } from '../adapters/git.js';
import type { ChangePolicyConfig } from '../profile/types.js';
import { scanPublicContent } from '../safety/redaction.js';

export interface ChangePolicyFinding {
  code: 'forbidden_path' | 'path_not_allowed' | 'file_too_large' | 'binary_file' | 'credential_value' | 'bearer_token' | 'private_key_block' | 'secret_keyword' | 'local_absolute_path' | 'file_unreadable' | 'symlink_path';
  path: string;
  message: string;
}

export interface ChangePolicyResult {
  ok: boolean;
  findings: ChangePolicyFinding[];
}

export async function evaluateChangePolicy(worktreePath: string, changedFiles: ChangedFile[], policy: ChangePolicyConfig): Promise<ChangePolicyResult> {
  const findings: ChangePolicyFinding[] = [];
  const realWorktreePath = await realpath(worktreePath);
  for (const changed of changedFiles) {
    const affectedPaths = [changed.path, changed.oldPath].filter((value): value is string => Boolean(value));
    for (const changedPath of affectedPaths) {
      if (!safeWorktreeJoin(worktreePath, changedPath)) {
        findings.push({ code: 'path_not_allowed', path: changedPath, message: `Changed path ${changedPath} escapes the worktree` });
      }
      if (matchesAny(changedPath, policy.forbidden_paths)) {
        findings.push({ code: 'forbidden_path', path: changedPath, message: `Changed path ${changedPath} is forbidden` });
      }
      if (policy.allowed_paths && !matchesAny(changedPath, policy.allowed_paths)) {
        findings.push({ code: 'path_not_allowed', path: changedPath, message: `Changed path ${changedPath} is outside allowed paths` });
      }
    }

    if (changed.status.startsWith('D')) continue;
    const absolute = safeWorktreeJoin(worktreePath, changed.path);
    if (!absolute) continue;

    let data: Buffer;
    try {
      const linkInfo = await lstat(absolute);
      if (linkInfo.isSymbolicLink()) {
        findings.push({ code: 'symlink_path', path: changed.path, message: `Changed file ${changed.path} is a symlink` });
        continue;
      }
      const real = await realpath(absolute);
      if (!isInsideWorktree(realWorktreePath, real)) {
        findings.push({ code: 'path_not_allowed', path: changed.path, message: `Changed file ${changed.path} resolves outside the worktree` });
        continue;
      }
      const info = await stat(absolute);
      if (info.size > policy.max_file_bytes) {
        findings.push({ code: 'file_too_large', path: changed.path, message: `Changed file ${changed.path} exceeds ${policy.max_file_bytes} bytes` });
        continue;
      }
      data = await readFile(absolute);
    } catch (error) {
      findings.push({ code: 'file_unreadable', path: changed.path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (!policy.allow_binary_files && isProbablyBinary(data)) {
      findings.push({ code: 'binary_file', path: changed.path, message: `Changed file ${changed.path} appears to be binary` });
      continue;
    }

    const text = data.toString('utf8');
    const scan = scanPublicContent(text, { surface: 'github' });
    for (const finding of scan.findings) {
      findings.push({ code: finding.code, path: changed.path, message: finding.message });
    }
  }
  return { ok: findings.length === 0, findings };
}

function safeWorktreeJoin(worktreePath: string, relativePath: string): string | null {
  const absoluteWorktree = path.resolve(worktreePath);
  const resolved = path.resolve(absoluteWorktree, relativePath);
  if (!isInsideWorktree(absoluteWorktree, resolved)) return null;
  return resolved;
}

function isInsideWorktree(worktreePath: string, candidate: string): boolean {
  const absoluteWorktree = path.resolve(worktreePath);
  const resolved = path.resolve(candidate);
  return resolved === absoluteWorktree || resolved.startsWith(`${absoluteWorktree}${path.sep}`);
}

function isProbablyBinary(data: Buffer): boolean {
  if (data.length === 0) return false;
  const sample = data.subarray(0, Math.min(data.length, 8192));
  return sample.includes(0);
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  return globToRegex(normalizedPattern).test(normalizedPath);
}

function globToRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      const after = pattern[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    source += escapeRegex(char ?? '');
    index += 1;
  }
  source += '$';
  return new RegExp(source, 'u');
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+/gu, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}

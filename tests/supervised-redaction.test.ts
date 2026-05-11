import { describe, expect, it } from 'vitest';
import { redactText, scanPublicContent } from '../src/supervised/safety/redaction.js';

describe('supervised redaction', () => {
  it('redacts Authorization bearer tokens', () => {
    expect(redactText('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts token query/key-value values', () => {
    expect(redactText('url=https://x.test?token=supersecret&ok=1')).toContain('token=[REDACTED]');
    expect(redactText('api_key: sk-live-1234567890')).toBe('api_key: [REDACTED]');
  });

  it('redacts private key blocks', () => {
    const input = 'before\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nafter';
    expect(redactText(input)).toBe('before\n[REDACTED_PRIVATE_KEY]\nafter');
  });

  it('flags local absolute paths as unsafe for GitHub-visible content', () => {
    const result = scanPublicContent('See /Users/homebase/.symphony/runs/run-1/result.md', { surface: 'github' });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('local_absolute_path');
  });

  it('flags common local absolute paths as unsafe for GitHub-visible content', () => {
    const inputs = [
      '/home/alice/project/file.ts',
      '/private/var/folders/tmp/file.ts',
      '/tmp/symphony/file.ts',
      'C:\\Users\\Alice\\project\\file.ts',
    ];

    for (const input of inputs) {
      const result = scanPublicContent(`See ${input}`, { surface: 'github' });
      expect(result.ok).toBe(false);
      expect(result.findings.map((finding) => finding.code)).toContain('local_absolute_path');
    }
  });

  it('allows generic tilde home shorthand in public docs', () => {
    const result = scanPublicContent('Profiles live under `~/.symphony` in the current implementation.', { surface: 'github' });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('does not treat URL paths as local absolute paths', () => {
    const result = scanPublicContent('Docs: https://example.com/home/docs and https://example.com/tmp/file', { surface: 'github' });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('allows local paths in Linear when explicitly configured', () => {
    const result = scanPublicContent('See /Users/homebase/.symphony/runs/run-1/result.md', { surface: 'linear', allowLocalPaths: true });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('flags likely secrets in public content after redaction scan', () => {
    const result = scanPublicContent('password=hunter2', { surface: 'github' });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('secret_keyword');
  });
});

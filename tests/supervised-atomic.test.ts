import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic, writeJsonAtomic } from '../src/supervised/storage/atomic.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-atomic-'));
}

describe('atomic storage writer', () => {
  it('writes JSON atomically and creates parent directories', async () => {
    const root = await tempDir();
    const target = join(root, 'nested', 'run.json');

    await writeJsonAtomic(target, { ok: true, count: 2 });

    const parsed = JSON.parse(await readFile(target, 'utf8')) as { ok: boolean; count: number };
    expect(parsed).toEqual({ ok: true, count: 2 });
  });

  it('overwrites existing files with complete new content', async () => {
    const root = await tempDir();
    const target = join(root, 'state.json');
    await writeFile(target, '{"old": true}');

    await writeJsonAtomic(target, { new: true });

    expect(await readFile(target, 'utf8')).toBe('{\n  "new": true\n}\n');
  });

  it('uses a temporary file in the same directory and cleans it up', async () => {
    const root = await tempDir();
    const target = join(root, 'artifact.txt');

    await writeFileAtomic(target, 'hello');

    expect(await readFile(target, 'utf8')).toBe('hello');
    const entries = await readdir(dirname(target));
    expect(entries).toEqual(['artifact.txt']);
  });
});

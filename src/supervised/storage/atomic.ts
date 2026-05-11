import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);

  const handle = await open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, targetPath);
  await fsyncDirectory(dir);
}

export async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await writeFileAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fsyncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms/filesystems.
  }
}

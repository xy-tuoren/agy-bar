import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    writeFileSync(targetPath, content, 'utf8');
  }
}

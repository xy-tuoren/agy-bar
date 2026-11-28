import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(targetPath, content, { mode = null, dirMode = null } = {}) {
  mkdirSync(dirname(targetPath), dirMode ? { recursive: true, mode: dirMode } : { recursive: true });
  const writeOpts = mode ? { encoding: 'utf8', mode } : 'utf8';
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, content, writeOpts);
    if (mode && process.platform !== 'win32') {
      chmodSync(tmpPath, mode);
    }
    renameSync(tmpPath, targetPath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    writeFileSync(targetPath, content, writeOpts);
    if (mode && process.platform !== 'win32') {
      try {
        chmodSync(targetPath, mode);
      } catch {
        // Ignore chmod errors on non-POSIX filesystems.
      }
    }
  }
}

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { sanitizeText } from './ansi.mjs';

export function findGitDir(startDir, maxDepth = 16) {
  if (!startDir || typeof startDir !== 'string') return null;
  let current = resolve(startDir);
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = join(current, '.git');
    if (existsSync(candidate)) {
      try {
        const stat = statSync(candidate);
        if (stat.isDirectory()) return { gitDir: candidate, workTree: current };
        if (stat.isFile()) {
          const content = readFileSync(candidate, 'utf8').trim();
          const match = /^gitdir:\s*(.+)$/i.exec(content);
          if (match) {
            const rawTarget = match[1].trim();
            const gitDir = isAbsolute(rawTarget) ? rawTarget : resolve(current, rawTarget);
            if (existsSync(gitDir)) return { gitDir, workTree: current };
          }
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function readBranchFromGitDir(gitDir) {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head) return null;
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, 'tag:');
      return sanitizeText(name) || null;
    }
    if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return head.slice(0, 7);
    }
    return null;
  } catch {
    return null;
  }
}

export function readGitInfo(cwd, { checkDirty = true, cachedDirty = null, timeoutMs = 120 } = {}) {
  if (!cwd || typeof cwd !== 'string') return null;
  const located = findGitDir(cwd);
  if (!located) return null;
  const branch = readBranchFromGitDir(located.gitDir);
  if (!branch) return null;

  let dirty = false;
  let dirtyChecked = false;
  if (checkDirty && typeof cachedDirty === 'boolean') {
    dirty = cachedDirty;
  } else if (checkDirty) {
    dirtyChecked = true;
    try {
      const out = execFileSync(
        'git',
        ['-C', located.workTree, 'status', '--porcelain', '--untracked-files=no'],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      dirty = out.trim().length > 0;
    } catch {
      // Never block or fail statusline rendering on git errors/timeouts.
      dirty = false;
    }
  }

  return { branch, dirty, dirtyChecked, workTree: located.workTree };
}

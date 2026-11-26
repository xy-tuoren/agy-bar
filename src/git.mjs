import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { sanitizeText } from './ansi.mjs';

const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_BYTES = 256 * 1024;

export function parseNumstatOutput(output) {
  let added = 0;
  let removed = 0;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    // Binary files report "-" for added/removed — skip them cleanly.
    const a = Number(parts[0]);
    const r = Number(parts[1]);
    if (Number.isFinite(a) && a > 0) added += Math.trunc(a);
    if (Number.isFinite(r) && r > 0) removed += Math.trunc(r);
  }
  return { added, removed };
}

export function countTextFileLines(filePath, maxBytes = MAX_UNTRACKED_BYTES) {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return 0;
    const buf = readFileSync(filePath);
    // Skip binary files containing NUL bytes.
    const probeLen = Math.min(buf.length, 8192);
    for (let i = 0; i < probeLen; i++) {
      if (buf[i] === 0) return 0;
    }
    let lines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) lines += 1;
    }
    if (buf[buf.length - 1] !== 0x0a) lines += 1;
    return lines;
  } catch {
    return 0;
  }
}

export function parsePorcelainZ(output) {
  let hasTrackedChanges = false;
  const untrackedPaths = [];
  const tokens = String(output || '').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status === '??') {
      if (filePath && !filePath.endsWith('/')) untrackedPaths.push(filePath);
    } else if (status !== '!!') {
      hasTrackedChanges = true;
      // Renamed/copied entries in porcelain -z consume a second NUL-delimited path token.
      if (status.includes('R') || status.includes('C')) i += 1;
    }
  }
  return { hasTrackedChanges, untrackedPaths };
}

function runGitCmd(workTree, args, timeoutMs) {
  return execFileSync('git', ['-C', workTree, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function readTrackedDiffStats(workTree, timeoutMs) {
  try {
    return parseNumstatOutput(runGitCmd(workTree, ['diff', '--numstat', 'HEAD'], timeoutMs));
  } catch {
    // Unborn HEAD (brand-new git repo before first commit): sum staged + unstaged diffs.
    let added = 0;
    let removed = 0;
    for (const args of [['diff', '--numstat', '--cached'], ['diff', '--numstat']]) {
      try {
        const part = parseNumstatOutput(runGitCmd(workTree, args, timeoutMs));
        added += part.added;
        removed += part.removed;
      } catch {
        // Ignore individual fallback failures.
      }
    }
    return { added, removed };
  }
}

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

export function readGitInfo(
  cwd,
  {
    checkDirty = true,
    checkDiff = false,
    cachedDirty = null,
    cachedDiff = null,
    timeoutMs = 140,
  } = {},
) {
  if (!cwd || typeof cwd !== 'string') return null;
  const located = findGitDir(cwd);
  if (!located) return null;
  const branch = readBranchFromGitDir(located.gitDir);
  if (!branch) return null;

  const needStatus = checkDirty || checkDiff;
  const hasCachedDirty = typeof cachedDirty === 'boolean';
  const hasCachedDiff = Boolean(
    cachedDiff && typeof cachedDiff.added === 'number' && typeof cachedDiff.removed === 'number',
  );

  let dirty = false;
  let dirtyChecked = false;
  let added = null;
  let removed = null;

  if (needStatus && hasCachedDirty && (!checkDiff || hasCachedDiff)) {
    dirty = cachedDirty;
    if (checkDiff) {
      added = cachedDiff.added;
      removed = cachedDiff.removed;
    }
  } else if (needStatus) {
    dirtyChecked = true;
    try {
      const statusArgs = checkDiff
        ? ['status', '--porcelain', '-z', '--untracked-files=all']
        : ['status', '--porcelain', '-z', '--untracked-files=no'];
      const out = runGitCmd(located.workTree, statusArgs, timeoutMs);
      const parsed = parsePorcelainZ(out);
      dirty = parsed.hasTrackedChanges || parsed.untrackedPaths.length > 0;

      if (checkDiff) {
        added = 0;
        removed = 0;
        if (parsed.hasTrackedChanges) {
          const tracked = readTrackedDiffStats(located.workTree, timeoutMs);
          added += tracked.added;
          removed += tracked.removed;
        }
        if (parsed.untrackedPaths.length > 0) {
          const limit = Math.min(parsed.untrackedPaths.length, MAX_UNTRACKED_FILES);
          for (let i = 0; i < limit; i++) {
            added += countTextFileLines(join(located.workTree, parsed.untrackedPaths[i]));
          }
        }
      }
    } catch {
      // Never block or fail statusline rendering on git errors/timeouts.
      dirty = false;
      if (checkDiff) {
        added = 0;
        removed = 0;
      }
    }
  }

  return checkDiff || hasCachedDiff
    ? { branch, dirty, dirtyChecked, added: added ?? 0, removed: removed ?? 0, workTree: located.workTree }
    : { branch, dirty, dirtyChecked, workTree: located.workTree };
}

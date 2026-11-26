import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findGitDir, readBranchFromGitDir, readGitInfo } from '../src/git.mjs';

test('reads branch name from nested folder inside a git repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-bar-git-'));
  try {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/dashboard\n');
    const nested = join(root, 'packages', 'cli');
    mkdirSync(nested, { recursive: true });

    const found = findGitDir(nested);
    assert.ok(found);
    assert.equal(readBranchFromGitDir(found.gitDir), 'feat/dashboard');

    const info = readGitInfo(nested, { checkDirty: false });
    assert.deepEqual(info, { branch: 'feat/dashboard', dirty: false, dirtyChecked: false, workTree: found.workTree });

    const cached = readGitInfo(nested, { checkDirty: true, cachedDirty: true });
    assert.deepEqual(cached, { branch: 'feat/dashboard', dirty: true, dirtyChecked: false, workTree: found.workTree });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reads short commit hash on detached HEAD and resolves git worktree file pointers', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-bar-wt-'));
  try {
    const actualGitDir = join(root, 'real-git-dir');
    mkdirSync(actualGitDir, { recursive: true });
    writeFileSync(join(actualGitDir, 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef12\n');

    const worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${actualGitDir}\n`);

    const info = readGitInfo(worktree, { checkDirty: false });
    assert.equal(info?.branch, 'abcdef1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns null outside any git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-nogit-'));
  try {
    // Only asserts readBranchFromGitDir doesn't crash when HEAD is missing.
    assert.equal(readBranchFromGitDir(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

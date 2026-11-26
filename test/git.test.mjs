import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { countTextFileLines, findGitDir, parseNumstatOutput, parsePorcelainZ, readBranchFromGitDir, readGitInfo } from '../src/git.mjs';

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

test('parses numstat/porcelain outputs and counts real tracked + untracked diff lines while skipping binaries', () => {
  assert.deepEqual(parseNumstatOutput('12\t4\tsrc/a.mjs\n-\t-\tlogo.png\n3\t0\tsrc/b.mjs\n'), {
    added: 15,
    removed: 4,
  });
  assert.deepEqual(parsePorcelainZ(' M src/a.mjs\0?? src/new.mjs\0R  new.mjs\0old.mjs\0'), {
    hasTrackedChanges: true,
    untrackedPaths: ['src/new.mjs'],
  });

  const repo = mkdtempSync(join(tmpdir(), 'agy-bar-gitdiff-'));
  try {
    const git = (args) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    git(['init', '-b', 'main']);
    writeFileSync(join(repo, 'app.js'), 'line1\nline2\nline3\n');
    git(['add', 'app.js']);
    git(['commit', '-m', 'init']);

    // Clean repo: +0 -0
    const clean = readGitInfo(repo, { checkDirty: true, checkDiff: true });
    assert.equal(clean.dirty, false);
    assert.equal(clean.added, 0);
    assert.equal(clean.removed, 0);

    // Edit tracked file (-1, +2), add untracked text file (+3), and add untracked binary file (skipped).
    writeFileSync(join(repo, 'app.js'), 'line1\nline2-edited\nline3\nline4\n');
    writeFileSync(join(repo, 'extra.txt'), 'a\nb\nc');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    assert.equal(countTextFileLines(join(repo, 'extra.txt')), 3);
    assert.equal(countTextFileLines(join(repo, 'blob.bin')), 0);

    const dirty = readGitInfo(repo, { checkDirty: true, checkDiff: true });
    assert.equal(dirty.branch, 'main');
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.added, 5); // 2 tracked + 3 untracked
    assert.equal(dirty.removed, 1);

    // Cached reuse skips subprocesses cleanly.
    const cached = readGitInfo(repo, {
      checkDirty: true,
      checkDiff: true,
      cachedDirty: true,
      cachedDiff: { added: 99, removed: 7 },
    });
    assert.equal(cached.dirtyChecked, false);
    assert.equal(cached.added, 99);
    assert.equal(cached.removed, 7);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

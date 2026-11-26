import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildShellHookBlock,
  detectShell,
  formatShellHookPrompt,
  hasCustomAgyDefinition,
  HOOK_END,
  HOOK_START,
  inspectShellHook,
  installShellHook,
  resolveInstallShellHookChoice,
  uninstallShellHook,
} from '../src/shell-hook.mjs';

test('detectShell identifies zsh, bash, fish, and Windows PowerShell', () => {
  assert.equal(detectShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' } }), 'zsh');
  assert.equal(detectShell({ platform: 'linux', env: { SHELL: '/usr/bin/fish' } }), 'fish');
  assert.equal(detectShell({ platform: 'linux', env: { SHELL: '/bin/bash' } }), 'bash');
  assert.equal(detectShell({ platform: 'win32', env: {} }), 'pwsh');
});

test('installShellHook installs idempotently, preserves existing content, and uninstalls cleanly', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-hook-'));
  try {
    const zshrc = join(fakeHome, '.zshrc');
    const original = 'export PATH="$HOME/.local/bin:$PATH"\n\n# my custom comment\n';
    writeFileSync(zshrc, original, 'utf8');

    const first = installShellHook({ home: fakeHome, shell: 'zsh', platform: 'darwin', env: {} });
    assert.equal(first.installed, true);
    assert.equal(first.updated, false);
    assert.equal(first.rcPath, zshrc);

    const afterFirst = readFileSync(zshrc, 'utf8');
    assert.ok(afterFirst.includes(original.trim()));
    assert.ok(afterFirst.includes(HOOK_START));
    assert.ok(afterFirst.includes('run --from-hook -- "$@"'));
    assert.ok(afterFirst.includes(HOOK_END));
    assert.equal(inspectShellHook({ home: fakeHome, shell: 'zsh', platform: 'darwin', env: {} }).installed, true);

    // Re-running installShellHook updates in-place without duplicating blocks.
    const second = installShellHook({ home: fakeHome, shell: 'zsh', platform: 'darwin', env: {} });
    assert.equal(second.installed, true);
    assert.equal(second.updated, true);
    const afterSecond = readFileSync(zshrc, 'utf8');
    assert.equal(afterSecond.split(HOOK_START).length - 1, 1);

    // Uninstall removes only the managed block and keeps user content intact.
    const removed = uninstallShellHook({ home: fakeHome, shell: 'zsh', platform: 'darwin', env: {} });
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.rcPaths, [zshrc]);
    const afterUninstall = readFileSync(zshrc, 'utf8');
    assert.ok(!afterUninstall.includes(HOOK_START));
    assert.ok(afterUninstall.includes('export PATH="$HOME/.local/bin:$PATH"'));
    assert.ok(afterUninstall.includes('# my custom comment'));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('installShellHook refuses to collide with custom user agy alias or function', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-hook-conflict-'));
  try {
    const zshrc = join(fakeHome, '.zshrc');
    const custom = "alias agy='my-custom-wrapper agy'\n";
    writeFileSync(zshrc, custom, 'utf8');

    assert.equal(hasCustomAgyDefinition(custom, 'zsh'), true);
    const res = installShellHook({ home: fakeHome, shell: 'zsh', platform: 'darwin', env: {} });
    assert.equal(res.installed, false);
    assert.equal(res.skipped, true);
    assert.match(res.warning, /custom "agy"/);
    assert.equal(readFileSync(zshrc, 'utf8'), custom);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('buildShellHookBlock generates fish and PowerShell functions with graceful fallback', () => {
  const fish = buildShellHookBlock('fish');
  assert.match(fish, /function agy --wraps agy/);
  assert.match(fish, /run --from-hook -- \$argv/);
  assert.match(fish, /command agy \$argv/);

  const pwsh = buildShellHookBlock('pwsh');
  assert.match(pwsh, /function agy \{/);
  assert.match(pwsh, /run --from-hook -- @args/);
  assert.match(pwsh, /Get-Command agy -CommandType Application/);
});

test('resolveInstallShellHookChoice prompts only on fresh interactive installs and stays safe non-interactively', async () => {
  const promptText = formatShellHookPrompt({ rcPath: '/Users/demo/.zshrc' });
  assert.match(promptText, /7-line managed agy\(\)/);
  assert.match(promptText, /agy-bar proxy unhook/);

  // Explicit CLI flags override prompting.
  assert.deepEqual(
    await resolveInstallShellHookChoice({ flagValue: true, isInteractive: true, promptFn: () => { throw new Error('should not prompt'); } }),
    { enable: true, reason: 'flag' },
  );
  assert.deepEqual(
    await resolveInstallShellHookChoice({ flagValue: false, alreadyInstalled: true, isInteractive: true }),
    { enable: false, reason: 'flag' },
  );

  // Upgrades preserve an already-installed hook without re-prompting.
  assert.deepEqual(
    await resolveInstallShellHookChoice({ alreadyInstalled: true, isInteractive: true, promptFn: () => { throw new Error('should not prompt'); } }),
    { enable: true, reason: 'preserved' },
  );

  // Fresh interactive install asks user cleanly.
  assert.deepEqual(
    await resolveInstallShellHookChoice({ isInteractive: true, promptFn: async () => true }),
    { enable: true, reason: 'prompt-yes' },
  );
  assert.deepEqual(
    await resolveInstallShellHookChoice({ isInteractive: true, promptFn: async () => false }),
    { enable: false, reason: 'prompt-no' },
  );

  // Non-interactive (scripts/CI/AI without flag) leaves shell rc untouched by default.
  assert.deepEqual(
    await resolveInstallShellHookChoice({ isInteractive: false, promptFn: async () => true }),
    { enable: false, reason: 'non-interactive-default' },
  );
  assert.deepEqual(
    await resolveInstallShellHookChoice({ isInteractive: true, yes: true, promptFn: async () => true }),
    { enable: false, reason: 'non-interactive-default' },
  );
});

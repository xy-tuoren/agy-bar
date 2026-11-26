import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agySettingsPath,
  buildCliShim,
  buildCommand,
  cliShimPath,
  installAgyBar,
  installedAppDir,
  isAgyBarCommand,
  MANAGED_SHIM_MARKER,
  runDoctor,
  uninstallAgyBar,
} from '../src/installer.mjs';
import { targetSkillPath } from '../src/skill.mjs';

test('buildCommand generates shell-safe commands for POSIX and Windows', () => {
  const macCmd = buildCommand('/opt/node bin/node', "/Users/xy's/.gemini/statusline.mjs", 'darwin');
  assert.equal(macCmd, `'/opt/node bin/node' '/Users/xy'\\''s/.gemini/statusline.mjs'`);

  const winCmd = buildCommand('C:\\Program Files\\node.exe', 'C:\\Users\\xy\\.gemini\\statusline.mjs', 'win32');
  assert.match(
    winCmd,
    /^node -e import\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\(\)\)\.then\(function\(m\)\{m\.runStatusline\(\)\}\)$/,
  );
});

test('install, upgrade, doctor, and uninstall preserve unrelated settings and restore previous statusLine', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-home-'));
  try {
    const settingsFile = agySettingsPath(fakeHome);
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          colorScheme: 'dark',
          model: 'Gemini 4 Carbon (High)',
          statusLine: { type: 'command', command: 'echo old-bar', enabled: true },
        },
        null,
        2,
      ),
    );

    // Default programmatic install leaves ~/.zshrc untouched unless opted in.
    const installed = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      withSkill: true,
      theme: 'nord',
    });
    assert.equal(installed.installed, true);
    assert.ok(existsSync(installed.scriptPath));
    assert.ok(existsSync(targetSkillPath(fakeHome)));
    assert.equal(installed.shimPath, cliShimPath(fakeHome, 'darwin'));
    assert.ok(existsSync(installed.shimPath));
    assert.ok(readFileSync(installed.shimPath, 'utf8').includes(MANAGED_SHIM_MARKER));
    assert.equal(installed.shellHook, null);
    assert.ok(!existsSync(join(fakeHome, '.zshrc')));

    const afterInstall = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(afterInstall.colorScheme, 'dark');
    assert.equal(afterInstall.model, 'Gemini 4 Carbon (High)');
    assert.equal(afterInstall.statusLine.enabled, true);
    assert.ok(afterInstall.statusLine.command.includes('agy-bar'));

    // Re-installing (upgrade) with shell hook opted in must keep the original backup ('echo old-bar').
    const upgraded = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      withSkill: true,
      withShellHook: true,
    });
    assert.equal(upgraded.shellHook?.installed, true);
    assert.ok(readFileSync(join(fakeHome, '.zshrc'), 'utf8').includes('# >>> agy-bar proxy >>>'));

    const report = runDoctor({ home: fakeHome, platform: 'darwin', env: { SHELL: '/bin/zsh' } });
    assert.equal(report.ok, true);

    const removed = uninstallAgyBar({ home: fakeHome, platform: 'darwin', env: { SHELL: '/bin/zsh' }, removeSkill: true });
    assert.equal(removed.uninstalled, true);
    assert.equal(removed.restored, true);
    assert.equal(removed.shimRemoved, true);
    assert.equal(removed.shellHookRemoved, true);
    assert.equal(removed.skillRemoved, true);
    assert.ok(!existsSync(cliShimPath(fakeHome, 'darwin')));
    assert.ok(!readFileSync(join(fakeHome, '.zshrc'), 'utf8').includes('# >>> agy-bar proxy >>>'));
    assert.ok(!existsSync(targetSkillPath(fakeHome)));

    const afterUninstall = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(afterUninstall.statusLine, {
      type: 'command',
      command: 'echo old-bar',
      enabled: true,
    });
    assert.equal(afterUninstall.colorScheme, 'dark');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('refuses to overwrite an unrelated agy-bar skill unless --no-skill is used', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-skill-conflict-'));
  try {
    const skillFile = targetSkillPath(fakeHome);
    mkdirSync(join(fakeHome, '.gemini', 'skills', 'agy-bar'), { recursive: true });
    writeFileSync(skillFile, '# My custom unrelated skill\n');

    assert.throws(
      () => installAgyBar({ home: fakeHome, executable: '/usr/local/bin/node', platform: 'linux', withSkill: true }),
      /unrelated agy-bar skill/,
    );
    assert.equal(readFileSync(skillFile, 'utf8'), '# My custom unrelated skill\n');

    const res = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'linux',
      withSkill: false,
    });
    assert.equal(res.installed, true);
    assert.equal(res.skillPath, null);
    assert.equal(readFileSync(skillFile, 'utf8'), '# My custom unrelated skill\n');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('does not overwrite an unrelated ~/.local/bin/agy-bar file and generates Windows .cmd shim cleanly', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-shim-conflict-'));
  try {
    const existingShim = cliShimPath(fakeHome, 'linux');
    mkdirSync(join(fakeHome, '.local', 'bin'), { recursive: true });
    writeFileSync(existingShim, '#!/bin/sh\necho custom-user-script\n');

    const res = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'linux',
      withSkill: false,
    });
    assert.equal(res.installed, true);
    assert.equal(res.shimPath, null);
    assert.match(res.shimWarning, /unrelated file/);
    assert.equal(readFileSync(existingShim, 'utf8'), '#!/bin/sh\necho custom-user-script\n');

    const winShim = buildCliShim('C:\\Program Files\\node.exe', 'C:\\Users\\xy\\agy-bar.mjs', 'win32');
    assert.match(winShim, /REM agy-bar: managed shim/);
    assert.match(winShim, /"C:\\Program Files\\node\.exe" "C:\\Users\\xy\\agy-bar\.mjs" %\*/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('self-reinstalling from installed app dir does not wipe runtime or fail on skill copy', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-self-reinstall-'));
  try {
    const first = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      withSkill: true,
    });
    assert.ok(existsSync(first.scriptPath));
    assert.ok(existsSync(join(installedAppDir(fakeHome), 'skills', 'agy-bar', 'SKILL.md')));

    // Simulate running `agy-bar install --proxy-hook` via the installed ~/.local/bin/agy-bar shim.
    const second = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      withSkill: true,
      withShellHook: true,
      sourceRoot: installedAppDir(fakeHome),
    });
    assert.equal(second.installed, true);
    assert.ok(existsSync(second.scriptPath));
    assert.ok(existsSync(second.cliPath));
    assert.ok(existsSync(targetSkillPath(fakeHome)));
    assert.equal(second.shellHook?.installed, true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('Windows install and runDoctor recognize Base64-encoded statusLine command', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-win-doctor-'));
  try {
    const installed = installAgyBar({
      home: fakeHome,
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
      env: {},
      withSkill: true,
    });
    assert.equal(installed.installed, true);
    assert.ok(!installed.command.includes('agy-bar'));
    assert.equal(isAgyBarCommand(installed.command), true);

    const report = runDoctor({ home: fakeHome, platform: 'win32', env: {} });
    assert.equal(report.ok, true);
    const settingsCheck = report.checks.find((c) => c.name === 'AGY settings.json');
    assert.equal(settingsCheck?.ok, true);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

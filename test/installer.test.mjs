import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agySettingsPath,
  buildCommand,
  installAgyBar,
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

    const installed = installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      withSkill: true,
      theme: 'nord',
    });
    assert.equal(installed.installed, true);
    assert.ok(existsSync(installed.scriptPath));
    assert.ok(existsSync(targetSkillPath(fakeHome)));

    const afterInstall = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(afterInstall.colorScheme, 'dark');
    assert.equal(afterInstall.model, 'Gemini 4 Carbon (High)');
    assert.equal(afterInstall.statusLine.enabled, true);
    assert.ok(afterInstall.statusLine.command.includes('agy-bar'));

    // Re-installing (upgrade) must keep the original backup ('echo old-bar').
    installAgyBar({
      home: fakeHome,
      executable: '/usr/local/bin/node',
      platform: 'darwin',
      withSkill: true,
    });

    const report = runDoctor({ home: fakeHome });
    assert.equal(report.ok, true);

    const removed = uninstallAgyBar({ home: fakeHome, removeSkill: true });
    assert.equal(removed.uninstalled, true);
    assert.equal(removed.restored, true);
    assert.equal(removed.skillRemoved, true);
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

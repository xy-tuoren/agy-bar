import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agyBrainDir,
  agyBrainTranscriptPath,
  agyCacheLastConversationsPath,
  buildHandoffPrompt,
  extractBrainArtifactsSummary,
  extractTranscriptDigest,
  findLatestConversationForCwd,
  prepareHandoff,
} from '../src/handoff.mjs';
import { buildHandoffResumeArgs, formatPromptArgForTarget, launchAgyWithProxy, parseRunArgs } from '../src/proxy.mjs';

test('handoff discovers latest conversation, redacts transcript secrets, and builds compact prompt', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-handoff-home-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  const workspace = join(home, 'projects', 'demo-app');
  mkdirSync(workspace, { recursive: true });

  try {
    const convId = 'conv-12345678-abcd';
    const cachePath = agyCacheLastConversationsPath(home);
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ [workspace]: convId }), 'utf8');

    const transcriptPath = agyBrainTranscriptPath(convId, home);
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs'), {
      recursive: true,
    });
    const transcriptLines = [
      JSON.stringify({ role: 'user', content: 'Implement cross-platform keyring support for alice@example.com' }),
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'Added macOS/Linux/Windows backends. Ignored token ya29.superSecretToken123.' }],
      }),
      JSON.stringify({ role: 'user', content: 'Now add unit tests and run npm test.' }),
    ];
    writeFileSync(transcriptPath, `${transcriptLines.join('\n')}\n`, 'utf8');
    writeFileSync(
      join(agyBrainDir(convId, home), 'task.md'),
      '# Tasks\n- [x] Keyring done\n- [ ] Finish handoff for owner@example.com\n',
      'utf8',
    );
    writeFileSync(
      join(agyBrainDir(convId, home), 'implementation_plan.md'),
      '# Plan\nShip cross-platform lossless handoff.\n',
      'utf8',
    );

    const found = findLatestConversationForCwd(workspace, { home, baseDir });
    assert.equal(found.conversationId, convId);
    assert.equal(found.source, 'agy-cache');

    const artifacts = extractBrainArtifactsSummary(convId, { home });
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].name, 'task.md');
    assert.equal(artifacts[1].name, 'implementation_plan.md');
    assert.ok(!artifacts[0].excerpt.includes('owner@example.com'));
    assert.ok(artifacts[0].excerpt.includes('***@***'));

    const digest = extractTranscriptDigest(convId, { home });
    assert.ok(digest.includes('Implement cross-platform keyring support'));
    assert.ok(!digest.includes('alice@example.com'));
    assert.ok(!digest.includes('ya29.superSecretToken123'));
    assert.ok(digest.includes('***@***'));
    assert.ok(digest.includes('[REDACTED]'));

    const handoff = prepareHandoff({
      cwd: workspace,
      home,
      baseDir,
      fromAlias: 'work',
      targetAlias: 'alt1',
      execFile: (cmd, args) => {
        assert.equal(cmd, 'git');
        if (args[0] === 'rev-parse') return 'feat/multi-account\n';
        if (args[0] === 'status') return ' M src/keyring.mjs\n?? test/keyring.test.mjs\n';
        if (args[0] === 'diff') return ' src/keyring.mjs | 42 ++++\n';
        if (args[0] === 'log') return 'a1b2c3d feat: add keyring adapter\n9f8e7d6 fix: tab title\n';
        return '';
      },
    });

    assert.equal(handoff.hasTranscript, true);
    assert.equal(handoff.artifactCount, 2);
    assert.equal(handoff.hasGit, true);
    assert.ok(handoff.prompt.includes('work -> alt1'));
    assert.ok(handoff.prompt.includes('feat/multi-account'));
    assert.ok(handoff.prompt.includes('a1b2c3d feat: add keyring adapter'));
    assert.ok(handoff.prompt.includes('In-flight files: `src/keyring.mjs`, `test/keyring.test.mjs`'));
    assert.ok(handoff.prompt.includes('## Active Plan & Artifacts'));
    assert.ok(handoff.prompt.includes('task.md'));
    assert.ok(handoff.prompt.includes('Now add unit tests'));
    assert.equal(existsSync(handoff.savedPath), true);
    assert.equal(readFileSync(handoff.savedPath, 'utf8').trim(), handoff.prompt);
    if (process.platform !== 'win32') {
      assert.equal(statSync(handoff.savedPath).mode & 0o777, 0o600);
    }

    // Works gracefully even without git or transcript.
    const minimal = buildHandoffPrompt({ cwd: workspace, targetAlias: 'alt1' });
    assert.ok(minimal.includes('demo-app'));
    assert.ok(minimal.includes('alt1'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('launchAgyWithProxy invokes multi-account drift guard and announces repaired drift on stderr', async () => {
  let stderrOut = '';
  let spawnedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    spawnedArgs = args;
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('exit', 0, null));
    return child;
  };

  const res = await launchAgyWithProxy(['--no-proxy', '--', '-i', 'hello'], {
    proxyConfig: { mode: 'off', url: null, bypass: ['127.0.0.1'] },
    env: {},
    spawnFn: fakeSpawn,
    stderr: {
      isTTY: true,
      write(chunk) {
        stderrOut += chunk;
      },
    },
    syncAccount: () => ({ active: true, synced: true, repairedFrom: 'work', alias: 'alt1' }),
  });

  assert.equal(res.exitCode, 0);
  assert.deepEqual(spawnedArgs, ['-i', 'hello']);
  assert.ok(stderrOut.includes('restored active account "alt1"'));
  assert.ok(stderrOut.includes('saved refreshed token for "work"'));
});

test('launchAgyWithProxy supports pre-launch auto-switch and exit-and-resume auto-handoff loop (skipping -p print mode)', async () => {
  assert.deepEqual(
    parseRunArgs(['--auto-switch', '--auto-handoff', '--family', 'claude', '--model', 'claude-opus-4-6']).options,
    {
      proxyUrl: null,
      noProxy: false,
      agyBin: null,
      quiet: false,
      fromHook: false,
      autoSwitch: true,
      autoHandoff: true,
      family: 'claude',
    },
  );
  assert.deepEqual(
    buildHandoffResumeArgs(['--model', 'gemini-4-neon', '-c', '-r', 'old-conv', '--effort', 'high'], 'resume now'),
    ['--model', 'gemini-4-neon', '--effort', 'high', '-i', 'resume now'],
  );

  const spawnCalls = [];
  let stderrOut = '';
  const fakeSpawn = (_cmd, args) => {
    spawnCalls.push([...args]);
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('exit', 0, null));
    return child;
  };

  let hookCalls = 0;
  const res = await launchAgyWithProxy(['--no-proxy', '--auto-switch', '--auto-handoff', '--model', 'gemini-4-neon'], {
    proxyConfig: { mode: 'off', url: null, bypass: ['127.0.0.1'] },
    env: {},
    spawnFn: fakeSpawn,
    stderr: {
      isTTY: true,
      write(chunk) {
        stderrOut += chunk;
      },
    },
    minAutoHandoffRunMs: 0,
    autoSwitchAccount: () => ({ switched: true, fromAlias: 'work', toAlias: 'alt1' }),
    autoHandoffHook: () => {
      hookCalls += 1;
      if (hookCalls === 1) {
        return {
          resume: true,
          prompt: 'handoff summary prompt',
          fromAlias: 'alt1',
          toAlias: 'alt2',
          family: 'gemini',
        };
      }
      return null;
    },
  });

  assert.equal(res.exitCode, 0);
  assert.equal(res.hops, 1);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0], ['--model', 'gemini-4-neon']);
  assert.deepEqual(spawnCalls[1], ['--model', 'gemini-4-neon', '-i', 'handoff summary prompt']);
  assert.ok(stderrOut.includes('auto-switched -> "alt1"'));
  assert.ok(stderrOut.includes('hit gemini limit — switched -> "alt2"'));

  // Print mode (-p) must never enter the interactive auto-handoff loop.
  let printHookRan = false;
  const printRes = await launchAgyWithProxy(['--no-proxy', '--auto-handoff', '-p', 'one shot'], {
    proxyConfig: { mode: 'off', url: null, bypass: ['127.0.0.1'] },
    env: {},
    spawnFn: fakeSpawn,
    stderr: { isTTY: false, write() {} },
    minAutoHandoffRunMs: 0,
    autoHandoffHook: () => {
      printHookRan = true;
      return { resume: true, prompt: 'should-not-run', fromAlias: 'a', toAlias: 'b' };
    },
  });
  assert.equal(printRes.hops, 0);
  assert.equal(printHookRan, false);

  // Windows .cmd shim safety: multi-line Markdown prompt with cmd.exe metacharacters degrades to single-line handoff file pointer.
  const multilineMd = 'Continue task\n## Git & Diff\ncmd1 | cmd2 > out';
  const winCmdSafe = formatPromptArgForTarget(multilineMd, {
    platform: 'win32',
    target: { command: 'C:\\Tools\\agy.cmd', shell: true },
    savedHandoffPath: 'C:\\Users\\alice\\.gemini\\config\\agy-bar\\handoffs\\latest.md',
  });
  assert.ok(!/[\r\n&|<>^%"]/.test(winCmdSafe));
  assert.ok(winCmdSafe.includes('C:/Users/alice/.gemini/config/agy-bar/handoffs/latest.md'));
  // Native agy.exe (shell: false) preserves full multi-line prompt verbatim.
  const winExeRaw = formatPromptArgForTarget(multilineMd, {
    platform: 'win32',
    target: { command: 'C:\\Tools\\agy.exe', shell: false },
    savedHandoffPath: 'C:\\Users\\alice\\.gemini\\config\\agy-bar\\handoffs\\latest.md',
  });
  assert.equal(winExeRaw, multilineMd);
});

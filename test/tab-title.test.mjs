import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildTabTitle,
  compactTitleText,
  formatOscTitle,
  resolveTerminalTty,
  syncTabTitle,
} from '../src/tab-title.mjs';
import { recordTelemetry, setSessionCustomTitle } from '../src/telemetry.mjs';
import { isNativeTitleActive, renderNativeTitle, runTitleCommand } from '../src/title.mjs';

test('compactTitleText strips URLs, slash commands, filler prefixes, and respects display width', () => {
  assert.equal(compactTitleText('请帮我优化 agy-bar 状态栏颜色'), '优化 agy-bar 状态栏颜色');
  assert.equal(compactTitleText('/goal 看看 https://example.com 这个项目架构'), '这个项目架构');
  assert.equal(compactTitleText('Please fix login auth bug', 18), 'fix login auth bug');
  assert.equal(compactTitleText('这是一个非常非常长的中文会话标题需要被智能截断', 16), '这是一个非常非…');
});

test('buildTabTitle formats working/idle prefix and supports auto, dir, title+dir, and custom overrides', () => {
  const payload = {
    agent_state: 'working',
    conversation_title: '开发 agy-bar 开源状态栏',
    workspace: { current_dir: '/Users/dev/agy-bar' },
  };
  assert.equal(buildTabTitle(payload, { config: { tabTitleSource: 'auto' } }), '● 开发 agy-bar 开源状态栏');
  assert.equal(
    buildTabTitle({ ...payload, agent_state: 'idle' }, { config: { tabTitleSource: 'dir' }, git: { branch: 'main', dirty: true } }),
    '✓ agy-bar (main*)',
  );
  assert.equal(
    buildTabTitle(payload, { config: { tabTitleSource: 'title+dir', tabTitleMaxLen: 26 } }),
    '● agy-bar · 开发 agy-bar 开…',
  );
  assert.equal(
    buildTabTitle(payload, { config: { tabTitleSource: 'auto' }, customTitle: '状态栏 Tab 标题' }),
    '● 状态栏 Tab 标题',
  );
  // Falls back to dir when conversation_title is absent.
  assert.equal(
    buildTabTitle({ agent_state: 'idle', workspace: { current_dir: '/Users/dev/agy-bar' } }, { git: { branch: 'main', dirty: false } }),
    '✓ agy-bar (main)',
  );

  // Idle main agent with running subagents shows ● [N] instead of ✓; reviewing/confirm shows ?; error shows ✗.
  assert.equal(
    buildTabTitle({
      agent_state: 'idle',
      conversation_title: '并行写小说',
      subagents: [{ status: 'running' }, { status: 'running' }, { status: 'completed' }],
    }),
    '● [2] 并行写小说',
  );
  assert.equal(
    buildTabTitle({ agent_state: 'reviewing', conversation_title: '确认部署方案' }),
    '? 确认部署方案',
  );
  assert.equal(
    buildTabTitle({ agent_state: 'working', tool_confirmation_pending: true, conversation_title: '执行命令' }),
    '? 执行命令',
  );
  assert.equal(
    buildTabTitle({ agent_state: 'error', conversation_title: '构建失败' }),
    '✗ 构建失败',
  );
  assert.equal(
    buildTabTitle({ agent_state: 'authenticating', workspace: { current_dir: '/Users/dev/agy-bar' } }),
    '… agy-bar',
  );
});

test('formatOscTitle sanitizes control characters and wraps in OSC 0 + OSC 2 sequence', () => {
  assert.equal(formatOscTitle('● 开发\x07\x1b[31magy-bar'), '\x1b]0;● 开发agy-bar\x07\x1b]2;● 开发agy-bar\x07');
});

test('resolveTerminalTty prefers ancestor agy TTY over subshell PTY and skips win32', () => {
  assert.equal(resolveTerminalTty({ platform: 'win32' }), null);
  assert.equal(resolveTerminalTty({ platform: 'darwin', env: { AGY_BAR_TTY: '/dev/ttys009' } }), '/dev/ttys009');

  const procs = {
    100: { ppid: 90, tty: 'ttys004', comm: 'node' },
    90: { ppid: 80, tty: 'ttys004', comm: 'zsh' },
    80: { ppid: 1, tty: 'ttys002', comm: '/Users/xy/.local/bin/agy' },
  };
  const resolved = resolveTerminalTty({
    platform: 'darwin',
    env: {},
    pid: 100,
    readProc: (pid) => procs[pid] || null,
    canWrite: (p) => p === '/dev/ttys002' || p === '/dev/ttys004',
  });
  assert.equal(resolved, '/dev/ttys002');
});

test('syncTabTitle deduplicates unchanged writes and writes OSC 0 when state or title changes', () => {
  const writes = [];
  const writer = (seq) => writes.push(seq);
  const payload = { agent_state: 'working', conversation_title: '调试状态栏' };

  const first = syncTabTitle(payload, { config: { tabTitle: true }, writer });
  assert.equal(first.changed, true);
  assert.equal(first.written, true);
  assert.equal(first.title, '● 调试状态栏');
  assert.equal(writes.length, 1);

  // Unchanged title -> skipped (zero spam on 300ms ticks).
  const second = syncTabTitle(payload, { config: { tabTitle: true }, prevTabTitle: first.title, writer });
  assert.equal(second.changed, false);
  assert.equal(writes.length, 1);

  // State switches working -> idle -> updates tab icon immediately.
  const third = syncTabTitle({ ...payload, agent_state: 'idle' }, { config: { tabTitle: true }, prevTabTitle: first.title, writer });
  assert.equal(third.changed, true);
  assert.equal(third.title, '✓ 调试状态栏');
  assert.equal(writes.length, 2);

  // Fast path: when title and hostPidHint match previous write, skips resolveTerminalTarget (zero `ps` spawns).
  const fastSkipped = syncTabTitle(payload, {
    config: { tabTitle: true },
    prevTabTitle: first.title,
    prevTabHostPid: 4242,
    hostPidHint: 4242,
    resolveOpts: {
      readProc: () => {
        throw new Error('fast path must not spawn ps');
      },
    },
  });
  assert.equal(fastSkipped.changed, false);
  assert.equal(fastSkipped.written, false);
  assert.equal(fastSkipped.hostPid, 4242);
});

test('setSessionCustomTitle persists override and auto-clears if AGY conversation_title changes via /rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-title-'));
  try {
    const t0 = 1_795_686_000_000;
    recordTelemetry(
      { conversation_id: 'conv-tab-1', conversation_title: '旧会话标题', agent_state: 'idle' },
      { now: t0, baseDir: dir },
    );

    const updated = setSessionCustomTitle('开发 agy-bar 状态栏', { sessionId: 'conv-tab-1', baseDir: dir, now: t0 + 1000 });
    assert.equal(updated.customTitle, '开发 agy-bar 状态栏');
    assert.equal(updated.customTitleBase, '旧会话标题');

    // Same conversation_title -> keeps custom override.
    const r1 = recordTelemetry(
      { conversation_id: 'conv-tab-1', conversation_title: '旧会话标题', agent_state: 'working' },
      { now: t0 + 2000, baseDir: dir },
    );
    assert.equal(r1.customTitle, '开发 agy-bar 状态栏');

    // User runs /rename in AGY -> conversation_title changes -> automatically supersedes customTitle.
    const r2 = recordTelemetry(
      { conversation_id: 'conv-tab-1', conversation_title: '全新重命名标题', agent_state: 'idle' },
      { now: t0 + 3000, baseDir: dir },
    );
    assert.equal(r2.customTitle, null);
    assert.equal(r2.conversationTitle, '全新重命名标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncTabTitle uses cached prevTabTty with zero ps calls on state transitions and never persists failed writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-tab-retry-'));
  try {
    const writes = [];
    const idlePayload = { conversation_id: 'conv-retry', agent_state: 'idle', conversation_title: '测试重试' };

    // Fast path 2: working -> idle under same hostPid writes directly to prevTabTty without invoking ps.
    const fastTransition = syncTabTitle(idlePayload, {
      config: { tabTitle: true },
      prevTabTitle: '● 测试重试',
      prevTabHostPid: 40384,
      prevTabTty: '/dev/ttys002',
      hostPidHint: 40384,
      writeToTty: (tty, seq) => {
        writes.push({ tty, seq });
        return true;
      },
      resolveOpts: {
        readProc: () => {
          throw new Error('cached TTY fast write must not spawn ps');
        },
      },
    });
    assert.equal(fastTransition.changed, true);
    assert.equal(fastTransition.written, true);
    assert.equal(fastTransition.tty, '/dev/ttys002');
    assert.equal(fastTransition.hostPid, 40384);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].tty, '/dev/ttys002');
    assert.ok(writes[0].seq.includes('✓ 测试重试'));

    // Failed write must NOT advance lastTabTitle in session state so subsequent ticks retry automatically.
    const t0 = 1_795_750_000_000;
    recordTelemetry(
      { conversation_id: 'conv-retry', agent_state: 'working', conversation_title: '测试重试' },
      {
        now: t0,
        baseDir: dir,
        tabSync: { changed: true, written: true, title: '● 测试重试', hostPid: 40384, tty: '/dev/ttys002', error: null },
      },
    );
    const failedIdle = recordTelemetry(
      idlePayload,
      {
        now: t0 + 1000,
        baseDir: dir,
        tabSync: { changed: true, written: false, title: '✓ 测试重试', hostPid: 40384, tty: null, error: 'no_tty' },
      },
    );
    assert.equal(failedIdle.prevTabTitle, '● 测试重试');

    const retriedIdle = recordTelemetry(
      idlePayload,
      {
        now: t0 + 2000,
        baseDir: dir,
        tabSync: { changed: true, written: true, title: '✓ 测试重试', hostPid: 40384, tty: '/dev/ttys002', error: null },
      },
    );
    assert.equal(retriedIdle.prevTabTitle, '✓ 测试重试');
    assert.equal(retriedIdle.prevTabTty, '/dev/ttys002');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native AGY title command renders single-line state titles, respects customTitle, and sets active marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-native-title-'));
  try {
    const t0 = 1_795_760_000_000;
    recordTelemetry(
      { conversation_id: 'conv-native-1', conversation_title: '原始标题', agent_state: 'working' },
      { now: t0, baseDir: dir },
    );
    setSessionCustomTitle('agy-bar 开源状态栏', { sessionId: 'conv-native-1', baseDir: dir, now: t0 + 500 });

    const idleTitle = renderNativeTitle(
      { conversation_id: 'conv-native-1', conversation_title: '原始标题', agent_state: 'idle' },
      { config: { tabTitle: true, tabTitleSource: 'auto', tabTitleMaxLen: 26 }, baseDir: dir, now: t0 + 1000, hostPid: 40384 },
    );
    assert.equal(idleTitle, '✓ agy-bar 开源状态栏');
    assert.equal(isNativeTitleActive('conv-native-1', { baseDir: dir, now: t0 + 5000, hostPid: 40384 }), true);

    const subTitle = renderNativeTitle(
      {
        conversation_id: 'conv-native-1',
        conversation_title: '原始标题',
        agent_state: 'idle',
        subagents: [{ status: 'running' }, { status: 'running' }],
      },
      { config: { tabTitle: true, tabTitleSource: 'auto', tabTitleMaxLen: 26 }, baseDir: dir, now: t0 + 2000, hostPid: 40384 },
    );
    assert.equal(subTitle, '● [2] agy-bar 开源状态栏');

    // Disabled config emits empty string.
    assert.equal(
      renderNativeTitle(
        { conversation_id: 'conv-native-1', agent_state: 'idle' },
        { config: { tabTitle: false }, baseDir: dir, now: t0 + 3000, hostPid: 40384 },
      ),
      '',
    );

    // End-to-end stdin -> stdout stream via runTitleCommand.
    let output = '';
    async function* fakeStdin() {
      yield JSON.stringify({ conversation_id: 'conv-native-1', conversation_title: '原始标题', agent_state: 'reviewing' });
    }
    await runTitleCommand({
      stdin: fakeStdin(),
      stdout: { write: (chunk) => { output += chunk; } },
      baseDir: dir,
      config: { tabTitle: true, tabTitleSource: 'auto', tabTitleMaxLen: 26 },
    });
    assert.equal(output, '? agy-bar 开源状态栏\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

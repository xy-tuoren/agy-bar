import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConversationSummaryTitle } from '../src/step-timing.mjs';
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
  // Idle agent with only a background task/dev server still shows ✓ on tab title (TASK N stays on statusline).
  assert.equal(
    buildTabTitle({ agent_state: 'idle', task_count: 1, conversation_title: '前端服务' }),
    '✓ 前端服务',
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
      now: t0 + 4000,
      hostPid: 40384,
    });
    assert.equal(output, '? agy-bar 开源状态栏\n');

    // Multi-tab custom title targeting prefers matching hostPid even when another session updated more recently.
    recordTelemetry(
      { conversation_id: 'conv-other-tab', conversation_title: '另一标签页', agent_state: 'working' },
      { now: t0 + 9_000, baseDir: dir, tabSync: { changed: true, written: true, title: '● 另一标签页', hostPid: 99999, tty: '/dev/ttys009', error: null } },
    );
    const targeted = setSessionCustomTitle('锁定本标签', { hostPid: 40384, baseDir: dir, now: t0 + 10_000 });
    assert.equal(targeted.sessionId, 'conv-native-1');
    assert.equal(targeted.customTitle, '锁定本标签');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to AGY conversation_summaries.db title on new conversations and preserves early customTitle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-sumtitle-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-sumhome-'));
  try {
    const convId = 'a445b358-ff85-43df-bbfa-77b1fbefcf4b';
    const t0 = 1_795_768_000_000;

    // 1. Anchoring customTitleBase when initial DB summary arrives after an early customTitle.
    recordTelemetry({ conversation_id: convId, agent_state: 'working' }, { now: t0, baseDir: dir });
    setSessionCustomTitle('标签页标题优化', { sessionId: convId, baseDir: dir, now: t0 + 100 });
    const afterDbArrives = recordTelemetry(
      { conversation_id: convId, agent_state: 'idle' },
      {
        now: t0 + 2000,
        baseDir: dir,
        summaryTitle: { title: 'Version 1.0 Release Status', dbStamp: '1:100:0:0', checkedAt: t0 + 2000 },
      },
    );
    // Initial background summary must NOT clobber the user/agent's customTitle.
    assert.equal(afterDbArrives.customTitle, '标签页标题优化');
    assert.equal(afterDbArrives.conversationTitle, 'Version 1.0 Release Status');

    // A subsequent /rename changes conversation_title relative to the anchored base -> supersedes customTitle.
    const afterRename = recordTelemetry(
      { conversation_id: convId, conversation_title: '发布后排查', agent_state: 'idle' },
      { now: t0 + 5000, baseDir: dir },
    );
    assert.equal(afterRename.customTitle, null);
    assert.equal(afterRename.conversationTitle, '发布后排查');

    // 2. Live SQLite fallback in readConversationSummaryTitle + renderNativeTitle (Node >= 22.13).
    let DatabaseSync = null;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      DatabaseSync = null;
    }
    if (DatabaseSync) {
      const agyDir = join(fakeHome, '.gemini', 'antigravity-cli');
      mkdirSync(agyDir, { recursive: true });
      const dbPath = join(agyDir, 'conversation_summaries.db');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "")');
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(convId, '项目代码分析与解读');
      db.close();

      const freshDir = mkdtempSync(join(tmpdir(), 'agy-bar-sumtitle-live-'));
      try {
        // Brand-new conversation payload omits conversation_title -> renderNativeTitle resolves DB title automatically.
        const resolved = renderNativeTitle(
          { conversation_id: convId, agent_state: 'idle', workspace: { current_dir: '/Users/dev/agy-bar' } },
          {
            config: { tabTitle: true, tabTitleSource: 'auto', tabTitleMaxLen: 26, dbTiming: true },
            home: fakeHome,
            baseDir: freshDir,
            now: t0,
            hostPid: 51515,
          },
        );
        assert.equal(resolved, '✓ 项目代码分析与解读');

        // Opting out via dbTiming: false falls back to workspace dir without opening SQLite.
        const optOut = renderNativeTitle(
          { conversation_id: convId, agent_state: 'idle', workspace: { current_dir: '/Users/dev/agy-bar' } },
          {
            config: { tabTitle: true, tabTitleSource: 'auto', tabTitleMaxLen: 26, dbTiming: false },
            home: fakeHome,
            baseDir: freshDir,
            now: t0,
            hostPid: 51515,
          },
        );
        assert.equal(optOut, '✓ agy-bar');

        // Matching dbStamp skips SQLite completely; recheckIntervalMs throttles repeated WAL writes once title is known.
        const first = readConversationSummaryTitle(convId, { home: fakeHome, now: t0 });
        assert.equal(first.title, '项目代码分析与解读');
        assert.equal(first.unchanged, false);

        const sameStamp = readConversationSummaryTitle(convId, {
          home: fakeHome,
          prevDbStamp: first.dbStamp,
          prevTitle: first.title,
          prevCheckedAt: t0,
          now: t0 + 60_000,
        });
        assert.equal(sameStamp.unchanged, true);
        assert.equal(sameStamp.title, '项目代码分析与解读');

        writeFileSync(`${dbPath}-wal`, 'simulated-wal-activity');
        const throttled = readConversationSummaryTitle(convId, {
          home: fakeHome,
          prevDbStamp: first.dbStamp,
          prevTitle: first.title,
          prevCheckedAt: t0,
          now: t0 + 3_000,
          recheckIntervalMs: 15_000,
        });
        assert.equal(throttled.unchanged, true);
        assert.equal(throttled.title, '项目代码分析与解读');
      } finally {
        rmSync(freshDir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

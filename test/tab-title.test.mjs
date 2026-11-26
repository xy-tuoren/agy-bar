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
});

test('formatOscTitle sanitizes control characters and wraps in OSC 0 sequence', () => {
  assert.equal(formatOscTitle('● 开发\x07\x1b[31magy-bar'), '\x1b]0;● 开发agy-bar\x07');
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

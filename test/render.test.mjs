import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripAnsi, visibleWidth } from '../src/ansi.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import {
  countRunningSubagents,
  extractActiveProxyLabel,
  formatReset,
  formatTokens,
  formatTtft,
  formatTurnElapsed,
  renderBar,
  renderStatusline,
} from '../src/render.mjs';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/payloads.json', import.meta.url), 'utf8'),
);

test('formatTokens and formatReset produce concise readable labels', () => {
  assert.equal(formatTokens(0), '--');
  assert.equal(formatTokens(512), '512');
  assert.equal(formatTokens(200000), '200K');
  assert.equal(formatTokens(1048576), '1.0M');

  assert.equal(formatReset({ reset_in_seconds: 0 }), 'due');
  assert.equal(formatReset({ reset_in_seconds: 42 }), '<1m');
  assert.equal(formatReset({ reset_in_seconds: 1500 }), '25m');
  assert.equal(formatReset({ reset_in_seconds: 9000 }), '2h30m');
  assert.equal(formatReset({ reset_in_seconds: 259200 }), '3d');
  assert.equal(formatReset({ reset_in_seconds: 273600 }), '3d4h');
});

test('renderBar supports segments, squares, pills, dots, smooth, blocks, line, and ascii styles', () => {
  assert.equal(renderBar(0.5, { width: 6, style: 'segments', color: false }), '▮▮▮▯▯▯');
  assert.equal(stripAnsi(renderBar(0.5, { width: 6, style: 'segments', fillColor: [52, 211, 153], trackColor: [60, 70, 80], color: true })), '▮▮▮▮▮▮');
  assert.equal(renderBar(0.5, { width: 6, style: 'squares', color: false }), '■■■□□□');
  assert.equal(renderBar(0.5, { width: 6, style: 'pills', color: false }), '▰▰▰▱▱▱');
  assert.equal(renderBar(0.5, { width: 6, style: 'dots', color: false }), '●●●○○○');
  assert.equal(renderBar(0.5, { width: 6, style: 'blocks', color: false }), '███░░░');
  assert.equal(renderBar(0.5, { width: 6, style: 'line', color: false }), '━━━───');
  assert.equal(renderBar(0.5, { width: 6, style: 'ascii', color: false }), '[###---]');
  // 42.6% of 8 cells = 27.26 eighths -> 3 full blocks + ▍ (3/8) + 4 empty
  assert.equal(renderBar(0.426, { width: 8, style: 'smooth', color: false }), '███▍░░░░');
  assert.equal(visibleWidth(renderBar(0.426, { width: 8, style: 'smooth', color: true })), 8);
});

test('health colorMode unifies healthy CTX bar color with right-side quota green, distinct uses accent blue', () => {
  const healthOut = renderStatusline(fixtures.geminiNormal, {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark', colorMode: 'health' }),
    color: true,
  });
  const metricsLine = healthOut.split('\n')[1];
  // slate-dark good green is 52;211;153; accent blue is 56;189;248.
  assert.ok(metricsLine.includes('\x1b[38;2;52;211;153m▮▮▮'));
  assert.ok(!metricsLine.includes('\x1b[38;2;56;189;248m▮▮▮'));

  const distinctOut = renderStatusline(fixtures.geminiNormal, {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark', colorMode: 'distinct' }),
    color: true,
  });
  assert.ok(distinctOut.split('\n')[1].includes('\x1b[38;2;56;189;248m▮▮▮'));
});

test('renders workspace dir + git, Vim badge, /compact danger hint, and optional cost/session metrics', () => {
  const payload = {
    ...fixtures.geminiCritical,
    terminal_width: 132,
    workspace: { current_dir: '/Users/dev/agy-bar' },
    vim: { mode: 'NORMAL' },
  };
  const out = renderStatusline(payload, {
    config: normalizeConfig({
      preset: 'dashboard',
      theme: 'slate-dark',
      show: { cost: true, session: true, compactHint: true },
    }),
    color: false,
    git: { branch: 'feat/v3', dirty: true },
    telemetry: {
      cacheRemainingSec: 18,
      speedTokPerSec: 92,
      sessionCostUsd: 0.42,
      sessionTurns: 8,
      sessionDurationSec: 720,
    },
  });
  const [line1, line2] = out.split('\n');
  assert.match(line1, /\[NORMAL\] · esc to cancel · agy-bar \(feat\/v3\*\)/);
  assert.match(line2, /92\.4% \(1\.0M\) →\/compact/);
  assert.match(line2, /~\$0\.42/);
  assert.match(line2, /12m·8t/);
});

test('renders minimal DAY, WK, MO, and ALL token totals on line 1 and sheds cleanly on narrow terminals', () => {
  const usageSummary = {
    todayTokens: 136_000_000,
    weekTokens: 810_000_000,
    monthTokens: 874_800_000,
    totalTokens: 906_200_000,
  };
  const wide = renderStatusline(
    { ...fixtures.geminiNormal, terminal_width: 140, workspace: { current_dir: '/Users/dev/agy-bar' } },
    { color: false, git: { branch: 'main', dirty: false }, usageSummary },
  ).split('\n')[0];
  assert.match(wide, /DAY 136\.0M · WK 810\.0M · MO 874\.8M · ALL 906\.2M │ Gemini 4 Carbon · high$/);

  const medium = renderStatusline(
    { ...fixtures.geminiNormal, terminal_width: 96, workspace: { current_dir: '/Users/dev/agy-bar' } },
    { color: false, git: { branch: 'main', dirty: false }, usageSummary },
  ).split('\n')[0];
  assert.ok(visibleWidth(medium) <= 94);
  assert.match(medium, /DAY 136\.0M/);
  assert.ok(!medium.includes('MO 874.8M'));

  const narrow = renderStatusline(
    { ...fixtures.geminiNormal, terminal_width: 52, workspace: { current_dir: '/Users/dev/agy-bar' } },
    { color: false, git: { branch: 'main', dirty: false }, usageSummary },
  ).split('\n')[0];
  assert.ok(visibleWidth(narrow) <= 50);
  assert.ok(!narrow.includes('ALL 906.2M'));
});

test('dashboard preset renders 2 lines with git, context bar, cache, and Gemini quota', () => {
  const out = renderStatusline(fixtures.geminiNormal, {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark' }),
    color: false,
    git: { branch: 'main', dirty: true },
  });
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\? for shortcuts · git:main\*/);
  assert.match(lines[0], /Gemini 4 Carbon · high$/);
  assert.match(lines[1], /CTX .*42\.6% \(1\.0M\)/);
  assert.match(lines[1], /CACHE 88%/);
  assert.match(lines[1], /5h .*85% \(2h30m\)/);
  assert.match(lines[1], /7d .*64% \(3d\)/);
  // Must not show disabled 3p-5h or Claude buckets when Gemini model is active.
  assert.ok(!out.includes('40%'));
});

test('selects Claude 3p quota buckets for Claude models and Argon bucket for Argon models', () => {
  const claudeOut = renderStatusline(fixtures.claude, { color: false });
  assert.match(claudeOut, /Claude Sonnet 4\.6 · medium/);
  assert.match(claudeOut, /5h .*72% \(1h30m\)/);
  assert.match(claudeOut, /7d .*55% \(3d11h\)/);
  assert.ok(!claudeOut.includes('99%'));

  const argonOut = renderStatusline(fixtures.argon, { color: false });
  assert.match(argonOut, /7d .*45% \(2d\)/);
  assert.ok(!argonOut.includes('90%'));
});

test('compact and minimal presets render a single line within terminal width', () => {
  const compact = renderStatusline(fixtures.geminiNormal, {
    config: normalizeConfig({ preset: 'compact', theme: 'ocean' }),
    color: true,
    git: { branch: 'main', dirty: false },
  });
  assert.equal(compact.split('\n').length, 1);
  assert.ok(visibleWidth(compact) <= 98);
  assert.match(stripAnsi(compact), /Gemini 4 Carbon/);
  assert.match(stripAnsi(compact), /git:main/);

  const minimal = renderStatusline(fixtures.geminiNormal, {
    config: normalizeConfig({ preset: 'minimal', theme: 'mono' }),
    color: true,
  });
  assert.equal(minimal.split('\n').length, 1);
  assert.equal(minimal, stripAnsi(minimal));
  assert.match(minimal, /CTX 42\.6% \(1\.0M\)/);
  assert.match(minimal, /5h 85% │ 7d 64%/);
});

test('working agent state displays esc to cancel and warning/danger ANSI colors trigger', () => {
  const critical = renderStatusline(fixtures.geminiCritical, {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark' }),
    color: true,
  });
  const plain = stripAnsi(critical);
  assert.match(plain, /esc to cancel/);
  assert.match(plain, /92\.4%/);
  assert.match(plain, /8%/);
  // Danger red RGB for slate-dark is 248;113;113
  assert.ok(critical.includes('\x1b[38;2;248;113;113m'));
});

test('never exceeds terminal_width - 2 across narrow and wide widths', () => {
  for (const width of [28, 36, 48, 60, 72, 80, 100, 140]) {
    for (const preset of ['dashboard', 'compact', 'minimal']) {
      const payload = { ...fixtures.geminiNormal, terminal_width: width };
      const rendered = renderStatusline(payload, {
        config: normalizeConfig({ preset, theme: 'slate-dark' }),
        color: true,
        git: { branch: 'feature/very-long-branch-name-for-testing', dirty: true },
      });
      for (const line of rendered.split('\n')) {
        assert.ok(
          visibleWidth(line) <= width - 2,
          `Line exceeded width ${width - 2} for preset=${preset} width=${width}: ${visibleWidth(line)} ("${stripAnsi(line)}")`,
        );
      }
    }
  }
});

test('handles empty or initial payloads without throwing', () => {
  const initialOut = renderStatusline(fixtures.initial, { color: false });
  assert.match(initialOut, /CTX/);
  assert.match(initialOut, /0\.0%/);

  const emptyOut = renderStatusline({}, { color: false });
  assert.match(emptyOut, /CTX/);
});

test('buildPreviewOutput applies overridden preset cleanly without leaking dashboard toggles', () => {
  const compactPreview = buildPreviewOutput({ scenario: 'normal', preset: 'compact', width: 96, color: false });
  assert.ok(!compactPreview.includes('CACHE'));
  assert.match(compactPreview, /Gemini 4 Neon │ git:main │ CTX/);

  const minimalPreview = buildPreviewOutput({ scenario: 'normal', preset: 'minimal', width: 80, color: false });
  assert.ok(!minimalPreview.includes('Gemini 4 Neon'));
  assert.ok(!minimalPreview.includes('CACHE'));
  assert.match(minimalPreview, /CTX 42\.6% \(1\.0M\)/);
});

test('renders Gemini 4 Neon, 5-min cache TTL countdown, tok/s speed, context delta, and per-model thresholds', () => {
  const neonPayload = {
    ...fixtures.geminiNormal,
    terminal_width: 120,
    model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', effort: 'medium' },
  };
  const out = renderStatusline(neonPayload, {
    config: normalizeConfig({
      preset: 'dashboard',
      theme: 'slate-dark',
      show: { contextDelta: true },
      modelThresholds: { neon: { warn: 35, danger: 50 } },
    }),
    color: true,
    telemetry: { cacheRemainingSec: 25, ttftMs: 1850, speedTokPerSec: 148.4, contextDelta: 14200 },
  });
  const plain = stripAnsi(out);
  assert.match(plain, /Gemini 4 Neon · medium/);
  assert.match(plain, /42\.6% \+14\.2K \(1\.0M\)/);
  assert.match(plain, /CACHE 88%·25s/);
  assert.match(plain, /TTFT 1\.9s·148t\/s/);
  assert.match(plain, /5h .*85%/);
  assert.equal(formatTtft(680), '680ms');
  assert.equal(formatTtft(6060), '6.1s');
  assert.equal(formatTtft(16400), '16s');
  // Warning amber RGB for slate-dark (251;191;36) triggered on 42.6% due to neon warn=35 override,
  // and danger red RGB (248;113;113) triggered on 25s cache TTL.
  assert.ok(out.includes('\x1b[38;2;251;191;36m'));
  assert.ok(out.includes('\x1b[38;2;248;113;113m'));
});

test('renders active proxy badge and on-demand work-state badges (turn timer, subagents, PLAN/SANDBOX)', () => {
  assert.equal(extractActiveProxyLabel({ HTTPS_PROXY: 'http://user:pass@127.0.0.1:7897' }), '7897');
  assert.equal(extractActiveProxyLabel({ HTTP_PROXY: 'http://proxy.internal' }), 'on');
  assert.equal(extractActiveProxyLabel({}), null);

  assert.equal(countRunningSubagents({ subagents: [{ status: 'running' }, { status: 'completed' }, { status: 'working' }] }), 2);
  assert.equal(countRunningSubagents({ subagents: [{ status: 'completed' }] }), 0);
  assert.equal(countRunningSubagents({ subagents: { running: 3 } }), 3);

  assert.equal(formatTurnElapsed(0), '');
  assert.equal(formatTurnElapsed(24), '24s');
  assert.equal(formatTurnElapsed(75), '1m15s');

  // Idle without proxy/subagents/special mode shows none of these badges (zero clutter).
  const idleLine = renderStatusline(
    { ...fixtures.geminiNormal, terminal_width: 130, workspace: { current_dir: '/Users/dev/agy-bar' } },
    { color: false, git: { branch: 'main', dirty: false }, telemetry: { turnElapsedSec: 40 }, env: {} },
  ).split('\n')[0];
  assert.ok(!idleLine.includes('PX '));
  assert.ok(!idleLine.includes('⚡'));
  assert.ok(!idleLine.includes('PLAN'));
  assert.ok(!idleLine.includes('SANDBOX'));
  assert.ok(!idleLine.includes('40s'));

  // Busy with proxy, running subagents, PLAN + SANDBOX, and live turn timer shows all badges cleanly.
  const activeOut = renderStatusline(
    {
      ...fixtures.geminiCritical,
      terminal_width: 140,
      workspace: { current_dir: '/Users/dev/agy-bar' },
      cycle_mode: 'plan',
      sandbox: { enabled: true },
      subagents: [{ status: 'running' }, { status: 'running' }, { status: 'completed' }],
    },
    {
      color: true,
      git: { branch: 'main', dirty: true },
      telemetry: { turnElapsedSec: 95 },
      env: { HTTPS_PROXY: 'http://alice:secret@127.0.0.1:7897' },
    },
  );
  const activeLine1 = stripAnsi(activeOut.split('\n')[0]);
  assert.match(activeLine1, /PLAN · SANDBOX · ⚡2 · esc to cancel · 1m35s · agy-bar \(main\*\) · PX 7897/);
  // Credentials must never leak into the rendered proxy badge.
  assert.ok(!activeLine1.includes('secret'));
  assert.ok(!activeLine1.includes('alice'));
});

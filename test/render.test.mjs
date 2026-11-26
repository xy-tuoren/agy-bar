import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripAnsi, visibleWidth } from '../src/ansi.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import { formatReset, formatTokens, renderBar, renderStatusline } from '../src/render.mjs';

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

test('renderBar supports blocks, line, and ascii styles', () => {
  assert.equal(renderBar(0.5, { width: 6, style: 'blocks', color: false }), '███░░░');
  assert.equal(renderBar(0.5, { width: 6, style: 'line', color: false }), '━━━───');
  assert.equal(renderBar(0.5, { width: 6, style: 'ascii', color: false }), '[###---]');
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
  assert.match(compactPreview, /Gemini 4 Carbon │ git:main │ CTX/);

  const minimalPreview = buildPreviewOutput({ scenario: 'normal', preset: 'minimal', width: 80, color: false });
  assert.ok(!minimalPreview.includes('Gemini 4 Carbon'));
  assert.ok(!minimalPreview.includes('CACHE'));
  assert.match(minimalPreview, /CTX 42\.6% \(1\.0M\)/);
});

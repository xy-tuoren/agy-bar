import assert from 'node:assert/strict';
import test from 'node:test';
import { clipAnsi, clipPlain, detectColorDepth, fg, rgbToAnsi256, sanitizeText, stripAnsi, visibleWidth } from '../src/ansi.mjs';

test('stripAnsi removes SGR color codes cleanly', () => {
  const colored = fg('hello', [56, 189, 248], true);
  assert.notEqual(colored, 'hello');
  assert.equal(stripAnsi(colored), 'hello');
});

test('sanitizeText strips ANSI and control characters', () => {
  assert.equal(sanitizeText('  \x1b[31mfake\x1b[0m\x07\nbranch  '), 'fakebranch');
});

test('visibleWidth accounts for ASCII, ANSI, and CJK characters', () => {
  assert.equal(visibleWidth('CTX 42.6%'), 9);
  assert.equal(visibleWidth(fg('CTX', [10, 20, 30]) + ' 42%'), 7);
  assert.equal(visibleWidth('中文ab'), 6);
});

test('clipPlain and clipAnsi respect display width and close ANSI sequences', () => {
  assert.equal(clipPlain('abcdef', 4), 'abcd');
  assert.equal(clipPlain('中文测试', 5), '中文');

  const styled = `${fg('CTX', [56, 189, 248])} ${fg('48.2% (1.0M)', [232, 236, 242])}`;
  const clipped = clipAnsi(styled, 8);
  assert.equal(visibleWidth(clipped), 8);
  assert.equal(stripAnsi(clipped), 'CTX 48.2');
  assert.ok(clipped.endsWith('\x1b[0m'));
});

test('detectColorDepth and 256-color fallback adapt across macOS Terminal.app, tmux, Windows Terminal, and Ghostty', () => {
  assert.equal(detectColorDepth({ TERM_PROGRAM: 'ghostty', COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectColorDepth({ WT_SESSION: 'win-term-guid' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM_PROGRAM: 'vscode' }), 'truecolor');
  assert.equal(detectColorDepth({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }), '256');
  assert.equal(detectColorDepth({ TERM: 'tmux-256color' }), '256');
  assert.equal(detectColorDepth({ TERM: 'dumb' }), 'none');
  assert.equal(detectColorDepth({ NO_COLOR: '' }), 'none');

  const idx = rgbToAnsi256(56, 189, 248);
  assert.ok(idx >= 16 && idx <= 255);
  assert.match(fg('CTX', [56, 189, 248], '256'), /^\x1b\[38;5;\d+mCTX\x1b\[0m$/);
  assert.equal(fg('CTX', [56, 189, 248], 'none'), 'CTX');
});

test('visibleWidth counts BMP emoji ⚡ as 2 columns while keeping gauge glyphs 1 column', () => {
  assert.equal(visibleWidth('⚡2'), 3);
  assert.equal(visibleWidth('▮▯■●✓→…·'), 8);
});

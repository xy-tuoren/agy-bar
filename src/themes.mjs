import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PALETTES = Object.freeze({
  'slate-dark': Object.freeze({
    text: [232, 236, 242],
    muted: [148, 163, 184],
    sep: [71, 85, 105],
    accent: [56, 189, 248],
    good: [52, 211, 153],
    warn: [251, 191, 36],
    danger: [248, 113, 113],
    track: [63, 73, 90],
    branch: [167, 139, 250],
  }),
  'slate-light': Object.freeze({
    text: [24, 32, 44],
    muted: [94, 108, 126],
    sep: [184, 194, 208],
    accent: [2, 132, 199],
    good: [5, 150, 105],
    warn: [180, 105, 0],
    danger: [220, 38, 38],
    track: [203, 213, 225],
    branch: [109, 40, 217],
  }),
  ocean: Object.freeze({
    text: [226, 241, 248],
    muted: [125, 170, 196],
    sep: [45, 92, 120],
    accent: [34, 211, 238],
    good: [45, 212, 191],
    warn: [250, 204, 21],
    danger: [251, 113, 133],
    track: [30, 68, 92],
    branch: [96, 165, 250],
  }),
  nord: Object.freeze({
    text: [236, 239, 244],
    muted: [165, 177, 194],
    sep: [76, 86, 106],
    accent: [136, 192, 208],
    good: [163, 190, 140],
    warn: [235, 203, 139],
    danger: [191, 97, 106],
    track: [67, 76, 94],
    branch: [180, 142, 173],
  }),
  mono: Object.freeze({
    text: null,
    muted: null,
    sep: null,
    accent: null,
    good: null,
    warn: null,
    danger: null,
    track: null,
    branch: null,
  }),
});

export const THEME_NAMES = Object.freeze(['auto', ...Object.keys(PALETTES)]);

export function detectSystemMode({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  queryWindows = () =>
    execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
      { encoding: 'utf8', windowsHide: true, timeout: 400, stdio: ['ignore', 'pipe', 'ignore'] },
    ),
} = {}) {
  try {
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    const scheme = String(raw.colorScheme || '').toLowerCase();
    if (scheme.includes('light')) return 'light';
    if (/dark|night|dracula|nord|tokyo|catppuccin|mocha/.test(scheme)) return 'dark';
  } catch {
    // Fall through to terminal/system hints.
  }

  if (platform === 'win32') {
    try {
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(queryWindows());
      if (match) return parseInt(match[1], 16) === 0 ? 'dark' : 'light';
    } catch {
      // Ignore registry failures.
    }
  }

  const colorfgbg = env.COLORFGBG;
  if (typeof colorfgbg === 'string' && colorfgbg.includes(';')) {
    const bg = Number(colorfgbg.split(';').at(-1));
    if (Number.isInteger(bg) && bg >= 0 && bg <= 15) {
      return bg === 7 || bg >= 9 ? 'light' : 'dark';
    }
  }

  return 'dark';
}

export function resolvePalette(themeName = 'auto', options = {}) {
  if (themeName === 'mono') {
    return { name: 'mono', color: false, palette: PALETTES.mono };
  }
  if (themeName && themeName !== 'auto' && Object.hasOwn(PALETTES, themeName)) {
    return { name: themeName, color: true, palette: PALETTES[themeName] };
  }
  const mode = detectSystemMode(options);
  const resolved = mode === 'light' ? 'slate-light' : 'slate-dark';
  return { name: resolved, color: true, palette: PALETTES[resolved] };
}

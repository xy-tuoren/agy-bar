import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';

const WIN_THEME_CACHE_TTL_MS = 5 * 60 * 1000;

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
  now = Date.now(),
  queryWindows = null,
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

  const colorfgbg = env.COLORFGBG;
  if (typeof colorfgbg === 'string' && colorfgbg.includes(';')) {
    const bg = Number(colorfgbg.split(';').at(-1));
    if (Number.isInteger(bg) && bg >= 0 && bg <= 15) {
      return bg === 7 || bg >= 9 ? 'light' : 'dark';
    }
  }

  if (platform === 'win32') {
    const cachePath = join(home, '.gemini', 'config', 'agy-bar', '.win-theme-cache.json');
    if (!queryWindows && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        if ((cached?.mode === 'dark' || cached?.mode === 'light') && now - Number(cached.checkedAt || 0) < WIN_THEME_CACHE_TTL_MS) {
          return cached.mode;
        }
      } catch {
        // Ignore stale/corrupt theme cache.
      }
    }

    try {
      const output = queryWindows
        ? queryWindows()
        : execFileSync(
            'reg.exe',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
            { encoding: 'utf8', windowsHide: true, timeout: 400, stdio: ['ignore', 'pipe', 'ignore'] },
          );
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output);
      if (match) {
        const mode = parseInt(match[1], 16) === 0 ? 'dark' : 'light';
        if (!queryWindows) {
          try {
            writeFileAtomic(cachePath, JSON.stringify({ mode, checkedAt: now }) + '\n');
          } catch {
            // Ignore cache write errors.
          }
        }
        return mode;
      }
    } catch {
      // Ignore registry failures.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { THEME_NAMES } from './themes.mjs';

export const BAR_STYLES = Object.freeze({
  blocks: Object.freeze({ fill: '█', empty: '░', wrap: ['', ''] }),
  line: Object.freeze({ fill: '━', empty: '─', wrap: ['', ''] }),
  ascii: Object.freeze({ fill: '#', empty: '-', wrap: ['[', ']'] }),
});

export const BAR_STYLE_NAMES = Object.freeze(Object.keys(BAR_STYLES));

export const PRESETS = Object.freeze({
  dashboard: Object.freeze({
    hint: true,
    model: true,
    effort: true,
    git: true,
    gitDirty: true,
    context: true,
    contextBar: true,
    capacity: true,
    cache: true,
    quota: true,
    quotaBar: true,
    quota5h: true,
    quotaWeekly: true,
    reset: true,
  }),
  compact: Object.freeze({
    hint: false,
    model: true,
    effort: false,
    git: true,
    gitDirty: true,
    context: true,
    contextBar: true,
    capacity: false,
    cache: false,
    quota: true,
    quotaBar: false,
    quota5h: true,
    quotaWeekly: true,
    reset: true,
  }),
  minimal: Object.freeze({
    hint: false,
    model: false,
    effort: false,
    git: false,
    gitDirty: false,
    context: true,
    contextBar: false,
    capacity: true,
    cache: false,
    quota: true,
    quotaBar: false,
    quota5h: true,
    quotaWeekly: true,
    reset: false,
  }),
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));
export const SHOW_KEYS = Object.freeze(Object.keys(PRESETS.dashboard));

export const DEFAULT_CONFIG = Object.freeze({
  preset: 'dashboard',
  theme: 'auto',
  barStyle: 'blocks',
  barWidth: 6,
  contextWarn: 70,
  contextDanger: 88,
  quotaWarn: 25,
  quotaDanger: 10,
  show: PRESETS.dashboard,
});

const SHOW_ALIASES = Object.freeze({
  hint: 'hint',
  model: 'model',
  effort: 'effort',
  git: 'git',
  gitdirty: 'gitDirty',
  'git-dirty': 'gitDirty',
  git_dirty: 'gitDirty',
  context: 'context',
  ctx: 'context',
  contextbar: 'contextBar',
  'context-bar': 'contextBar',
  context_bar: 'contextBar',
  capacity: 'capacity',
  cap: 'capacity',
  cache: 'cache',
  quota: 'quota',
  quotabar: 'quotaBar',
  'quota-bar': 'quotaBar',
  quota_bar: 'quotaBar',
  quota5h: 'quota5h',
  'quota-5h': 'quota5h',
  quota_5h: 'quota5h',
  '5h': 'quota5h',
  quotaweekly: 'quotaWeekly',
  'quota-weekly': 'quotaWeekly',
  quota_weekly: 'quotaWeekly',
  weekly: 'quotaWeekly',
  '7d': 'quotaWeekly',
  reset: 'reset',
});

export function configDir(home = homedir()) {
  return join(home, '.gemini', 'config', 'agy-bar');
}

export function configPath(home = homedir()) {
  return join(configDir(home), 'config.json');
}

export function resolveShowKey(name) {
  return SHOW_ALIASES[String(name || '').toLowerCase()] || null;
}

export function parseToggle(value) {
  const v = String(value ?? '').toLowerCase();
  if (['on', 'true', '1', 'yes', 'show'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'hide'].includes(v)) return false;
  return null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preset = PRESET_NAMES.includes(input.preset) ? input.preset : DEFAULT_CONFIG.preset;
  const theme = THEME_NAMES.includes(input.theme) ? input.theme : DEFAULT_CONFIG.theme;
  const barStyle = BAR_STYLE_NAMES.includes(input.barStyle) ? input.barStyle : DEFAULT_CONFIG.barStyle;
  const barWidth = clampInt(input.barWidth, 4, 14, DEFAULT_CONFIG.barWidth);
  const contextWarn = clampInt(input.contextWarn, 10, 95, DEFAULT_CONFIG.contextWarn);
  const contextDanger = clampInt(input.contextDanger, contextWarn, 99, DEFAULT_CONFIG.contextDanger);
  const quotaDanger = clampInt(input.quotaDanger, 1, 50, DEFAULT_CONFIG.quotaDanger);
  const quotaWarn = clampInt(input.quotaWarn, quotaDanger, 80, DEFAULT_CONFIG.quotaWarn);

  const show = { ...PRESETS[preset] };
  if (input.show && typeof input.show === 'object' && !Array.isArray(input.show)) {
    for (const key of SHOW_KEYS) {
      if (typeof input.show[key] === 'boolean') {
        show[key] = input.show[key];
      }
    }
  }

  return {
    preset,
    theme,
    barStyle,
    barWidth,
    contextWarn,
    contextDanger,
    quotaWarn,
    quotaDanger,
    show,
  };
}

export function computeShowOverrides(preset, show) {
  const base = PRESETS[preset] || PRESETS.dashboard;
  const overrides = {};
  for (const key of SHOW_KEYS) {
    if (show[key] !== base[key]) overrides[key] = show[key];
  }
  return overrides;
}

export function serializeConfig(cfg) {
  const normalized = normalizeConfig(cfg);
  const out = {
    preset: normalized.preset,
    theme: normalized.theme,
    barStyle: normalized.barStyle,
    barWidth: normalized.barWidth,
  };
  if (normalized.contextWarn !== DEFAULT_CONFIG.contextWarn) out.contextWarn = normalized.contextWarn;
  if (normalized.contextDanger !== DEFAULT_CONFIG.contextDanger) out.contextDanger = normalized.contextDanger;
  if (normalized.quotaWarn !== DEFAULT_CONFIG.quotaWarn) out.quotaWarn = normalized.quotaWarn;
  if (normalized.quotaDanger !== DEFAULT_CONFIG.quotaDanger) out.quotaDanger = normalized.quotaDanger;
  const overrides = computeShowOverrides(normalized.preset, normalized.show);
  if (Object.keys(overrides).length > 0) out.show = overrides;
  return out;
}

export function loadConfig(path = configPath()) {
  try {
    if (!existsSync(path)) return normalizeConfig(null);
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return normalizeConfig(raw);
  } catch {
    return normalizeConfig(null);
  }
}

export function saveConfig(cfg, path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = serializeConfig(cfg);
  writeFileSync(path, JSON.stringify(serialized, null, 2) + '\n', 'utf8');
  return normalizeConfig(serialized);
}

export function applyConfigCommand(args = [], path = configPath()) {
  const [action = 'show', ...rest] = args;
  const current = loadConfig(path);

  if (action === 'show' && rest.length === 0) {
    return {
      path,
      config: current,
      overrides: computeShowOverrides(current.preset, current.show),
    };
  }

  let next = { ...current, show: { ...current.show } };

  if (action === 'reset' && rest.length === 0) {
    next = normalizeConfig(null);
  } else if (action === 'preset' && rest.length === 1) {
    const preset = rest[0].toLowerCase();
    if (!PRESET_NAMES.includes(preset)) {
      throw new Error(`Invalid preset "${rest[0]}". Choose one of: ${PRESET_NAMES.join(', ')}`);
    }
    next.preset = preset;
    next.show = { ...PRESETS[preset] };
  } else if (action === 'theme' && rest.length === 1) {
    const theme = rest[0].toLowerCase();
    if (!THEME_NAMES.includes(theme)) {
      throw new Error(`Invalid theme "${rest[0]}". Choose one of: ${THEME_NAMES.join(', ')}`);
    }
    next.theme = theme;
  } else if ((action === 'bar-style' || action === 'barStyle') && rest.length === 1) {
    const barStyle = rest[0].toLowerCase();
    if (!BAR_STYLE_NAMES.includes(barStyle)) {
      throw new Error(`Invalid barStyle "${rest[0]}". Choose one of: ${BAR_STYLE_NAMES.join(', ')}`);
    }
    next.barStyle = barStyle;
  } else if ((action === 'enable' || action === 'disable') && rest.length > 0) {
    const flag = action === 'enable';
    for (const item of rest) {
      const key = resolveShowKey(item);
      if (!key) {
        throw new Error(`Unknown item "${item}". Choose from: ${SHOW_KEYS.join(', ')}`);
      }
      next.show[key] = flag;
    }
  } else if (action === 'set' && rest.length >= 2 && rest.length % 2 === 0) {
    for (let i = 0; i < rest.length; i += 2) {
      const [key, value] = [rest[i], rest[i + 1]];
      const lower = key.toLowerCase();
      if (lower === 'preset') {
        if (!PRESET_NAMES.includes(value.toLowerCase())) {
          throw new Error(`Invalid preset "${value}". Choose: ${PRESET_NAMES.join(', ')}`);
        }
        next.preset = value.toLowerCase();
        next.show = { ...PRESETS[next.preset] };
      } else if (lower === 'theme') {
        if (!THEME_NAMES.includes(value.toLowerCase())) {
          throw new Error(`Invalid theme "${value}". Choose: ${THEME_NAMES.join(', ')}`);
        }
        next.theme = value.toLowerCase();
      } else if (['barstyle', 'bar-style', 'bar_style'].includes(lower)) {
        if (!BAR_STYLE_NAMES.includes(value.toLowerCase())) {
          throw new Error(`Invalid barStyle "${value}". Choose: ${BAR_STYLE_NAMES.join(', ')}`);
        }
        next.barStyle = value.toLowerCase();
      } else if (['barwidth', 'bar-width', 'bar_width'].includes(lower)) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 4 || n > 14) {
          throw new Error('barWidth must be an integer between 4 and 14.');
        }
        next.barWidth = n;
      } else if (['contextwarn', 'context-warn'].includes(lower)) {
        next.contextWarn = Number(value);
      } else if (['contextdanger', 'context-danger'].includes(lower)) {
        next.contextDanger = Number(value);
      } else if (['quotawarn', 'quota-warn'].includes(lower)) {
        next.quotaWarn = Number(value);
      } else if (['quotadanger', 'quota-danger'].includes(lower)) {
        next.quotaDanger = Number(value);
      } else if (lower.startsWith('show.')) {
        const target = resolveShowKey(lower.slice(5));
        if (!target) throw new Error(`Unknown setting "${key}".`);
        const parsed = parseToggle(value);
        if (parsed === null) throw new Error(`${key} must be on/off (or true/false).`);
        next.show[target] = parsed;
      } else {
        throw new Error(`Unknown setting "${key}".`);
      }
    }
  } else {
    throw new Error(
      'Usage: agy-bar config <show | preset <name> | theme <name> | bar-style <style> | enable <items...> | disable <items...> | set <k> <v>... | reset>',
    );
  }

  const saved = saveConfig(next, path);
  return {
    path,
    saved: true,
    config: saved,
    overrides: computeShowOverrides(saved.preset, saved.show),
  };
}

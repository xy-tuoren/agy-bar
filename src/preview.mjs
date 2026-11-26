import { loadConfig, normalizeConfig } from './config.mjs';
import { renderStatusline } from './render.mjs';

export const SAMPLE_PAYLOADS = Object.freeze({
  normal: Object.freeze({
    version: '1.5.16',
    agent_state: 'idle',
    terminal_width: 116,
    workspace: { current_dir: '/Users/dev/agy-bar' },
    model: {
      id: 'gemini-4-neon',
      display_name: 'Gemini 4 Neon (XHigh)',
      effort: 'xhigh',
    },
    context_window: {
      context_window_size: 1048576,
      used_percentage: 42.6,
      remaining_percentage: 57.4,
      current_usage: {
        input_tokens: 14200,
        output_tokens: 1850,
        cache_read_input_tokens: 104000,
      },
    },
    quota: {
      'gemini-5h': { remaining_fraction: 0.85, reset_in_seconds: 9000 },
      'gemini-weekly': { remaining_fraction: 0.64, reset_in_seconds: 259200 },
    },
  }),
  warning: Object.freeze({
    version: '1.5.16',
    agent_state: 'working',
    terminal_width: 116,
    workspace: { current_dir: '/Users/dev/agy-bar' },
    vim: { mode: 'NORMAL' },
    model: {
      id: 'gemini-4-carbon',
      display_name: 'Gemini 4 Carbon (High)',
      effort: 'high',
    },
    context_window: {
      context_window_size: 1048576,
      used_percentage: 76.4,
      remaining_percentage: 23.6,
      current_usage: {
        input_tokens: 41000,
        output_tokens: 2400,
        cache_read_input_tokens: 59000,
      },
    },
    quota: {
      'gemini-5h': { remaining_fraction: 0.22, reset_in_seconds: 4500 },
      'gemini-weekly': { remaining_fraction: 0.38, reset_in_seconds: 172800 },
    },
  }),
  critical: Object.freeze({
    version: '1.5.16',
    agent_state: 'tool_use',
    terminal_width: 116,
    workspace: { current_dir: '/Users/dev/agy-bar' },
    model: {
      id: 'gemini-4-carbon',
      display_name: 'Gemini 4 Carbon (High)',
      effort: 'high',
    },
    context_window: {
      context_window_size: 1048576,
      used_percentage: 92.8,
      remaining_percentage: 7.2,
      current_usage: {
        input_tokens: 72000,
        output_tokens: 3100,
        cache_read_input_tokens: 18000,
      },
    },
    quota: {
      'gemini-5h': { remaining_fraction: 0.08, reset_in_seconds: 1620 },
      'gemini-weekly': { remaining_fraction: 0.09, reset_in_seconds: 86400 },
    },
  }),
  claude: Object.freeze({
    version: '1.5.16',
    agent_state: 'idle',
    terminal_width: 116,
    workspace: { current_dir: '/Users/dev/web-app' },
    model: {
      id: 'claude-sonnet-4-6',
      display_name: 'Claude Sonnet 4.6',
      effort: 'medium',
    },
    context_window: {
      context_window_size: 200000,
      used_percentage: 31.2,
      remaining_percentage: 68.8,
      current_usage: {
        input_tokens: 8000,
        output_tokens: 900,
        cache_read_input_tokens: 54000,
      },
    },
    quota: {
      '3p-5h': { remaining_fraction: 0.74, reset_in_seconds: 7200 },
      '3p-weekly': { remaining_fraction: 0.51, reset_in_seconds: 345600 },
    },
  }),
});

export const SAMPLE_TELEMETRY = Object.freeze({
  normal: Object.freeze({
    cacheRemainingSec: 222,
    ttftMs: 1850,
    speedTokPerSec: 158,
    contextDelta: 12400,
    sessionCostUsd: 0.18,
    sessionTurns: 6,
    sessionDurationSec: 540,
  }),
  warning: Object.freeze({
    cacheRemainingSec: 68,
    ttftMs: 8400,
    speedTokPerSec: 112,
    contextDelta: 34800,
    sessionCostUsd: 0.84,
    sessionTurns: 14,
    sessionDurationSec: 1620,
  }),
  critical: Object.freeze({
    cacheRemainingSec: 18,
    ttftMs: 16200,
    speedTokPerSec: 64,
    contextDelta: 61200,
    sessionCostUsd: 2.35,
    sessionTurns: 28,
    sessionDurationSec: 3900,
  }),
  claude: Object.freeze({
    cacheRemainingSec: 255,
    ttftMs: 2100,
    speedTokPerSec: 126,
    contextDelta: 8900,
    sessionCostUsd: 0.42,
    sessionTurns: 9,
    sessionDurationSec: 780,
  }),
});

export function buildPreviewOutput({
  scenario = 'normal',
  width = 116,
  preset = null,
  theme = null,
  barStyle = null,
  colorMode = null,
  color = true,
} = {}) {
  const base = loadConfig();
  const switchingPreset = Boolean(preset && preset !== base.preset);
  const cfg = normalizeConfig({
    ...base,
    ...(switchingPreset ? { preset, show: undefined } : preset ? { preset } : {}),
    ...(theme ? { theme } : {}),
    ...(barStyle ? { barStyle } : {}),
    ...(colorMode ? { colorMode } : {}),
  });

  const names = scenario === 'all' ? Object.keys(SAMPLE_PAYLOADS) : [scenario];
  const blocks = [];

  for (const name of names) {
    const template = SAMPLE_PAYLOADS[name];
    if (!template) {
      throw new Error(`Unknown scenario "${name}". Choose: ${Object.keys(SAMPLE_PAYLOADS).join(', ')}, all`);
    }
    const payload = { ...template, terminal_width: width };
    const git =
      name === 'warning' || name === 'critical'
        ? { branch: 'feat/statusline', dirty: true }
        : { branch: 'main', dirty: false };
    const rendered = renderStatusline(payload, {
      config: cfg,
      color,
      git,
      telemetry: SAMPLE_TELEMETRY[name],
    });
    const rule = '─'.repeat(Math.max(12, width - 2));
    blocks.push(
      `[${name} · preset=${cfg.preset} · theme=${cfg.theme} · color=${cfg.colorMode} · bar=${cfg.barStyle} · ${width} cols]\n${rule}\n${rendered}\n${rule}`,
    );
  }

  return blocks.join('\n\n');
}

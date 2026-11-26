import { bold, clipAnsi, fg, sanitizeText, visibleWidth } from './ansi.mjs';
import { BAR_STYLES, DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { resolvePalette } from './themes.mjs';

const KNOWN_BUCKETS = Object.freeze({
  'gemini-5h': Object.freeze({ group: 'Gemini', kind: '5h', label: '5h' }),
  'gemini-weekly': Object.freeze({ group: 'Gemini', kind: 'weekly', label: '7d' }),
  'gemini-argon-wtu-weekly': Object.freeze({ group: 'Argon', kind: 'weekly', label: '7d' }),
  '3p-5h': Object.freeze({ group: 'Claude', kind: '5h', label: '5h' }),
  '3p-weekly': Object.freeze({ group: 'Claude', kind: 'weekly', label: '7d' }),
});

const BUCKET_ORDER = Object.keys(KNOWN_BUCKETS);

function nonNegNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatTokens(value) {
  const n = nonNegNumber(value);
  if (n === null || n === 0) return '--';
  if (n < 1000) return String(Math.round(n));
  if (n < 999950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatReset(bucket, now = Date.now()) {
  if (!bucket || typeof bucket !== 'object') return '';
  const ts = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
  const seconds = Number.isFinite(ts) ? (ts - now) / 1000 : nonNegNumber(bucket.reset_in_seconds);
  if (seconds === null) return '';
  if (seconds <= 0) return 'due';
  if (seconds < 60) return '<1m';
  const totalMin = Math.ceil(seconds / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 24) return remMin > 0 ? `${totalHours}h${remMin}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

export function renderBar(ratio, { width = 6, style = 'blocks', fillColor, trackColor, color = true } = {}) {
  const spec = BAR_STYLES[style] || BAR_STYLES.blocks;
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filledCount = Math.round(clamped * width);
  const emptyCount = Math.max(0, width - filledCount);
  const filled = filledCount > 0 ? fg(spec.fill.repeat(filledCount), fillColor, color) : '';
  const empty = emptyCount > 0 ? fg(spec.empty.repeat(emptyCount), trackColor, color) : '';
  const leftWrap = spec.wrap[0] ? fg(spec.wrap[0], trackColor, color) : '';
  const rightWrap = spec.wrap[1] ? fg(spec.wrap[1], trackColor, color) : '';
  return `${leftWrap}${filled}${empty}${rightWrap}`;
}

export function detectModelGroup(model, quota) {
  const name = `${model?.id || ''} ${model?.display_name || ''}`.toLowerCase();
  if (/claude|sonnet|opus|haiku/.test(name)) return 'Claude';
  if (name.includes('argon') && quota && Object.hasOwn(quota, 'gemini-argon-wtu-weekly')) return 'Argon';
  if (/gemini|hydrogen|carbon|argon|pro|flash/.test(name)) return 'Gemini';
  return null;
}

export function formatModelName(model, includeEffort = true) {
  const raw = sanitizeText(model?.display_name || model?.id || '');
  const effort = sanitizeText(model?.effort || '');
  if (!raw) return '--';
  const cleaned = effort
    ? raw.replace(/\s*\((?:low|medium|high|xhigh|max)\)$/i, '').trim()
    : raw;
  return includeEffort && effort ? `${cleaned} · ${effort}` : cleaned;
}

function selectQuotaEntries(quota, model, show) {
  if (!quota || typeof quota !== 'object' || !show.quota) return [];
  const selectedGroup = detectModelGroup(model, quota);
  const entries = Object.entries(quota)
    .filter(([, bucket]) => bucket && typeof bucket === 'object' && bucket.disabled !== true)
    .sort(([a], [b]) => {
      const ia = BUCKET_ORDER.indexOf(a);
      const ib = BUCKET_ORDER.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });

  const matched = [];
  for (const [id, bucket] of entries) {
    const meta = KNOWN_BUCKETS[id];
    if (selectedGroup && meta && meta.group !== selectedGroup) continue;
    if (selectedGroup && !meta) continue;
    const kind = meta?.kind || 'other';
    if (kind === '5h' && !show.quota5h) continue;
    if (kind === 'weekly' && !show.quotaWeekly) continue;
    matched.push({
      id,
      kind,
      label: meta?.label || sanitizeText(id) || 'Q',
      bucket,
    });
  }
  return matched;
}

function joinWithSep(parts, sepText, palette, color) {
  const nonEmpty = parts.filter(Boolean);
  if (nonEmpty.length <= 1) return nonEmpty[0] || '';
  const styledSep = fg(sepText, palette.sep, color);
  return nonEmpty.join(styledSep);
}

function alignRow(left, right, width) {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (!left && !right) return '';
  if (!right) return lw > width ? clipAnsi(left, width) : left;
  if (!left) return rw > width ? clipAnsi(right, width) : ' '.repeat(Math.max(0, width - rw)) + right;
  const gap = width - lw - rw;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  // Last-resort clip so a line never wraps.
  if (rw + 2 <= width) {
    const clippedLeft = clipAnsi(left, width - rw - 1);
    const finalGap = Math.max(1, width - visibleWidth(clippedLeft) - rw);
    return clippedLeft + ' '.repeat(finalGap) + right;
  }
  return clipAnsi(`${left} ${right}`, width);
}

function formatGitSegment(git, show, palette, color, maxBranchLen = 24) {
  if (!show.git || !git || !git.branch) return '';
  let branch = sanitizeText(git.branch);
  if (!branch) return '';
  if (branch.length > maxBranchLen) {
    branch = `${branch.slice(0, Math.max(4, maxBranchLen - 1))}…`;
  }
  const dirtyMark = show.gitDirty && git.dirty ? fg('*', palette.warn, color) : '';
  return `${fg('git:', palette.muted, color)}${fg(branch, palette.branch, color)}${dirtyMark}`;
}

function renderMetaLine(payload, width, config, palette, color, git) {
  const { show } = config;
  const isBusy = ['working', 'tool_use', 'thinking'].includes(payload?.agent_state);
  const hintText = show.hint ? (isBusy ? 'esc to cancel' : '? for shortcuts') : '';
  const rightText = show.model ? formatModelName(payload?.model, show.effort) : '';
  const right = rightText ? fg(rightText, palette.muted, color) : '';

  const gitFull = formatGitSegment(git, show, palette, color, 26);
  const gitShort = formatGitSegment(git, show, palette, color, 14);

  const candidates = [
    () => joinWithSep([hintText ? fg(hintText, palette.muted, color) : '', gitFull], ' · ', palette, color),
    () => joinWithSep([hintText ? fg(hintText, palette.muted, color) : '', gitShort], ' · ', palette, color),
    () => gitShort || (hintText ? fg(hintText, palette.muted, color) : ''),
    () => '',
  ];

  for (const buildLeft of candidates) {
    const left = buildLeft();
    const minGap = left && right ? 2 : 0;
    if (visibleWidth(left) + minGap + visibleWidth(right) <= width) {
      return alignRow(left, right, width);
    }
  }
  return alignRow('', right, width);
}

function computeCachePercent(context) {
  const usage = context?.current_usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = nonNegNumber(usage.input_tokens);
  const cached = nonNegNumber(usage.cache_read_input_tokens);
  if (input === null || cached === null || input + cached <= 0) return null;
  return (cached / (input + cached)) * 100;
}

function buildContextSegment(context, opts, config, palette, color) {
  const { show, barStyle, barWidth, contextWarn, contextDanger } = config;
  if (!show.context) return '';
  const pct = nonNegNumber(context?.used_percentage);
  const size = nonNegNumber(context?.context_window_size);
  const pctText = pct === null ? '--' : `${pct.toFixed(1)}%`;
  const tone =
    pct === null
      ? palette.muted
      : pct >= contextDanger
        ? palette.danger
        : pct >= contextWarn
          ? palette.warn
          : palette.accent;

  const pieces = [];
  pieces.push(fg(opts.shortLabel ? 'C' : 'CTX', palette.muted, color));
  if (opts.withBar && show.contextBar) {
    const bar = renderBar(pct === null ? 0 : pct / 100, {
      width: Math.min(8, barWidth + 2),
      style: barStyle,
      fillColor: tone,
      trackColor: palette.track,
      color,
    });
    pieces.push(bar);
  }
  pieces.push(pct !== null && pct >= contextWarn ? bold(fg(pctText, tone, color), color) : fg(pctText, palette.text, color));
  if (opts.withCapacity && show.capacity && size !== null && size > 0) {
    pieces.push(fg(`(${formatTokens(size)})`, palette.muted, color));
  }
  return pieces.join(' ');
}

function buildCacheSegment(context, opts, config, palette, color) {
  if (!opts.withCache || !config.show.cache) return '';
  const hit = computeCachePercent(context);
  if (hit === null) return '';
  const hitText = `${Math.round(hit)}%`;
  const tone = hit >= 70 ? palette.good : hit >= 30 ? palette.text : palette.warn;
  return `${fg('CACHE', palette.muted, color)} ${fg(hitText, tone, color)}`;
}

function buildQuotaSegment(entries, opts, config, palette, color, now) {
  if (!entries.length) return '';
  const { show, barStyle, barWidth, quotaWarn, quotaDanger } = config;
  const parts = entries.map(({ label, bucket }) => {
    const fraction = nonNegNumber(bucket.remaining_fraction);
    const amount = nonNegNumber(bucket.remaining_amount);
    const pct = fraction !== null ? Math.round(fraction * 100) : null;
    const valText = pct !== null ? `${pct}%` : amount !== null ? formatTokens(amount) : '--';
    const tone =
      pct === null
        ? palette.muted
        : pct <= quotaDanger
          ? palette.danger
          : pct <= quotaWarn
            ? palette.warn
            : palette.good;

    const pieces = [fg(label, palette.muted, color)];
    if (opts.withQuotaBar && show.quotaBar && fraction !== null) {
      pieces.push(
        renderBar(fraction, {
          width: barWidth,
          style: barStyle,
          fillColor: tone,
          trackColor: palette.track,
          color,
        }),
      );
    }
    pieces.push(pct !== null && pct <= quotaWarn ? bold(fg(valText, tone, color), color) : fg(valText, palette.text, color));
    if (opts.withReset && show.reset) {
      const reset = formatReset(bucket, now);
      if (reset) pieces.push(fg(`(${reset})`, palette.muted, color));
    }
    return pieces.join(' ');
  });

  return joinWithSep(parts, opts.tight ? ' ' : ' │ ', palette, color);
}

function renderMetricsRow(payload, width, config, palette, color, now, { includePrefix = false, git = null } = {}) {
  const context = payload?.context_window || {};
  const quotaEntries = selectQuotaEntries(payload?.quota, payload?.model, config.show);
  const sep = ' │ ';

  const stages = [
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: false, withCache: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: false, withReset: true, withCache: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: false, withReset: false, withCache: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCapacity: false, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCapacity: false, shortLabel: true, tight: true },
  ];

  let chosenLeft = '';
  let chosenRight = '';
  for (const stage of stages) {
    const leftParts = [];
    if (stage.withPrefix && config.show.model) {
      leftParts.push(fg(formatModelName(payload?.model, config.show.effort), palette.text, color));
    }
    if (stage.withGit) {
      const gitSeg = formatGitSegment(git, config.show, palette, color, 16);
      if (gitSeg) leftParts.push(gitSeg);
    }
    const ctxSeg = buildContextSegment(context, stage, config, palette, color);
    if (ctxSeg) leftParts.push(ctxSeg);
    const cacheSeg = buildCacheSegment(context, stage, config, palette, color);
    if (cacheSeg) leftParts.push(cacheSeg);

    const left = joinWithSep(leftParts, stage.tight ? ' ' : sep, palette, color);
    const right = buildQuotaSegment(quotaEntries, stage, config, palette, color, now);
    const minGap = left && right ? 2 : 0;
    chosenLeft = left;
    chosenRight = right;
    if (visibleWidth(left) + minGap + visibleWidth(right) <= width) {
      return alignRow(left, right, width);
    }
  }

  return alignRow(chosenLeft, chosenRight, width);
}

export function renderFallback(config = DEFAULT_CONFIG, { color = false, theme = 'slate-dark' } = {}) {
  const cfg = normalizeConfig(config);
  const { palette, color: themeColor } = resolvePalette(theme);
  const useColor = color && themeColor;
  const parts = [];
  if (cfg.show.context) parts.push(`${fg('CTX', palette.muted, useColor)} ${fg('--', palette.text, useColor)}`);
  if (cfg.show.quota) parts.push(`${fg('5h', palette.muted, useColor)} ${fg('--', palette.text, useColor)}`);
  return parts.join(fg(' │ ', palette.sep, useColor)) || 'agy-bar';
}

export function renderStatusline(
  payload = {},
  {
    config = DEFAULT_CONFIG,
    now = Date.now(),
    color = true,
    git = null,
    themeOptions = {},
  } = {},
) {
  const cfg = normalizeConfig(config);
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const width = Math.max(12, Math.floor(nonNegNumber(safePayload.terminal_width) || 80) - 2);
  const resolved = resolvePalette(cfg.theme, themeOptions);
  const useColor = Boolean(color) && resolved.color;
  const { palette } = resolved;

  if (cfg.preset === 'compact') {
    const row = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
      includePrefix: true,
      git,
    });
    return row || renderFallback(cfg, { color: useColor, theme: resolved.name });
  }

  if (cfg.preset === 'minimal') {
    const row = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
      includePrefix: false,
      git: null,
    });
    return row || renderFallback(cfg, { color: useColor, theme: resolved.name });
  }

  // Default: 2-line dashboard preset.
  const lines = [];
  if (cfg.show.hint || cfg.show.model || cfg.show.git) {
    const meta = renderMetaLine(safePayload, width, cfg, palette, useColor, git);
    if (meta) lines.push(meta);
  }
  const metrics = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
    includePrefix: false,
    git: null,
  });
  if (metrics) lines.push(metrics);

  return lines.length > 0 ? lines.join('\n') : renderFallback(cfg, { color: useColor, theme: resolved.name });
}

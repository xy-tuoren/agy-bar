import { homedir } from 'node:os';
import { classifyAgentActivity, countRunningSubagents } from './agent-state.mjs';
import { bold, clipAnsi, detectColorDepth, fg, sanitizeText, visibleWidth } from './ansi.mjs';
import { BAR_STYLES, DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { formatUsd } from './pricing.mjs';
import { resolvePalette } from './themes.mjs';

export { countRunningSubagents };

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
  if (n < 999_950_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function formatCompactTokens(value) {
  const n = nonNegNumber(value);
  if (n === null || n === 0) return '--';
  if (n >= 100_000_000 && n < 999_950_000) return `${Math.round(n / 1_000_000)}M`;
  return formatTokens(n);
}

function formatCompactUsd(amount) {
  const v = nonNegNumber(amount);
  if (v === null || v <= 0) return '';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  return `$${Math.round(v)}`;
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

export function formatCacheTtl(seconds) {
  const sec = nonNegNumber(seconds);
  if (sec === null) return '';
  if (sec <= 0) return 'exp';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function formatTtft(ms) {
  const value = nonNegNumber(ms);
  if (value === null || value === 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  const sec = value / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function formatDurationShort(seconds) {
  const sec = nonNegNumber(seconds);
  if (sec === null) return '';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

export function renderBar(ratio, { width = 6, style = 'segments', fillColor, trackColor, color = true } = {}) {
  const spec = BAR_STYLES[style] || BAR_STYLES.segments;
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const emptyGlyph = !color && spec.plainEmpty ? spec.plainEmpty : spec.empty;

  let body = '';
  if (spec.partial) {
    const eighths = Math.round(clamped * width * 8);
    const full = Math.floor(eighths / 8);
    const rem = eighths % 8;
    const partialChar = rem > 0 ? spec.partial[rem] : '';
    const emptyCount = Math.max(0, width - full - (partialChar ? 1 : 0));
    const filledStr = spec.fill.repeat(full) + partialChar;
    const filled = filledStr ? fg(filledStr, fillColor, color) : '';
    const empty = emptyCount > 0 ? fg(emptyGlyph.repeat(emptyCount), trackColor, color) : '';
    body = `${filled}${empty}`;
  } else {
    const filledCount = Math.round(clamped * width);
    const emptyCount = Math.max(0, width - filledCount);
    const filled = filledCount > 0 ? fg(spec.fill.repeat(filledCount), fillColor, color) : '';
    const empty = emptyCount > 0 ? fg(emptyGlyph.repeat(emptyCount), trackColor, color) : '';
    body = `${filled}${empty}`;
  }

  const leftWrap = spec.wrap[0] ? fg(spec.wrap[0], trackColor, color) : '';
  const rightWrap = spec.wrap[1] ? fg(spec.wrap[1], trackColor, color) : '';
  return `${leftWrap}${body}${rightWrap}`;
}

export function detectModelGroup(model, quota) {
  const name = `${model?.id || ''} ${model?.display_name || ''}`.toLowerCase();
  if (/claude|sonnet|opus|haiku/.test(name)) return 'Claude';
  if (name.includes('argon') && quota && Object.hasOwn(quota, 'gemini-argon-wtu-weekly')) return 'Argon';
  if (/gemini|hydrogen|carbon|argon|neon|pro|flash/.test(name)) return 'Gemini';
  return null;
}

export function resolveContextThresholds(model, config) {
  const name = `${model?.id || ''} ${model?.display_name || ''}`.toLowerCase();
  const overrides = config.modelThresholds || {};
  for (const [key, entry] of Object.entries(overrides)) {
    if (key && name.includes(key.toLowerCase())) {
      return { warn: entry.warn, danger: entry.danger };
    }
  }
  return { warn: config.contextWarn, danger: config.contextDanger };
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

export function selectQuotaEntries(quota, model, show) {
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
  if (rw + 2 <= width) {
    const clippedLeft = clipAnsi(left, width - rw - 1);
    const finalGap = Math.max(1, width - visibleWidth(clippedLeft) - rw);
    return clippedLeft + ' '.repeat(finalGap) + right;
  }
  return clipAnsi(`${left} ${right}`, width);
}

function formatVimBadge(payload, show, palette, color) {
  if (!show.vim) return '';
  const mode = sanitizeText(payload?.vim?.mode || '').toUpperCase();
  if (!mode) return '';
  const tone = mode.includes('INSERT') ? palette.good : mode.includes('VISUAL') ? palette.branch : palette.accent;
  return bold(fg(`[${mode}]`, tone, color), color);
}

export function extractActiveProxyLabel(env = {}) {
  if (!env || typeof env !== 'object') return null;
  const raw =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    '';
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return null;
    return parsed.port ? parsed.port : 'on';
  } catch {
    return null;
  }
}

export function formatTurnElapsed(seconds) {
  const sec = nonNegNumber(seconds);
  if (sec === null || sec < 1) return '';
  const whole = Math.floor(sec);
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, '0')}m`;
}

function formatModeBadges(payload, show, palette, color) {
  if (!show.mode) return '';
  const badges = [];
  const cycleMode = sanitizeText(payload?.cycle_mode || payload?.execution_mode || '').toLowerCase();
  if (cycleMode === 'plan') {
    badges.push(bold(fg('PLAN', palette.warn, color), color));
  }
  const sandboxOn = payload?.sandbox === true || payload?.sandbox?.enabled === true;
  if (sandboxOn) {
    badges.push(bold(fg('SANDBOX', palette.branch, color), color));
  }
  return joinWithSep(badges, ' · ', palette, color);
}

function formatAttentionBadge(activity, show, palette, color) {
  if (!activity.statusBadge || (!show.mode && !show.hint)) return '';
  const tone = activity.kind === 'error' ? palette.danger : palette.warn;
  return bold(fg(activity.statusBadge, tone, color), color);
}

function formatSubagentsBadge(activity, show, palette, color) {
  if (!show.subagents || activity.runningSubagents <= 0) return '';
  return `${fg('SUB', palette.muted, color)} ${bold(fg(String(activity.runningSubagents), palette.accent, color), color)}`;
}

function formatTasksBadge(activity, show, palette, color) {
  if (!show.subagents || activity.runningTasks <= 0) return '';
  return `${fg('TASK', palette.muted, color)} ${fg(String(activity.runningTasks), palette.accent, color)}`;
}

function formatBusySegment(isBusy, telemetry, show, palette, color) {
  if (!isBusy) return '';
  const sec = show.turnTimer ? nonNegNumber(telemetry?.turnElapsedSec) : null;
  const elapsed = sec !== null && sec >= 1 ? formatTurnElapsed(sec) : '';
  const dotTone = sec !== null && sec >= 90 ? palette.danger : sec !== null && sec >= 30 ? palette.warn : palette.accent;
  const parts = [];

  if (elapsed) {
    const timerText =
      sec >= 90 ? bold(fg(elapsed, palette.danger, color), color) : sec >= 30 ? fg(elapsed, palette.warn, color) : fg(elapsed, palette.text, color);
    parts.push(`${fg('●', dotTone, color)} ${timerText}`);
  } else if (show.hint) {
    parts.push(fg('●', dotTone, color));
  }

  if (show.hint) {
    parts.push(fg('esc', palette.muted, color));
  }

  return parts.join(parts.length === 2 && !elapsed ? ' ' : fg(' · ', palette.sep, color));
}

function formatProxyBadge(env, show, palette, color) {
  if (!show.proxy) return '';
  const label = extractActiveProxyLabel(env);
  if (!label) return '';
  return `${fg('PX', palette.muted, color)} ${fg(label, palette.good, color)}`;
}

export function formatCompactPath(rawCwd, { style = 'short', maxLen = 28, home = homedir() } = {}) {
  const clean = sanitizeText(rawCwd || '');
  if (!clean) return '';

  const normalized = clean.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const normHome = sanitizeText(home || '').replace(/\\/g, '/').replace(/\/+$/, '');

  const lastSeg = normalized === '/' ? '/' : normalized.split('/').filter(Boolean).at(-1) || normalized;
  if (style === 'name') return lastSeg;

  const caseInsensitive = process.platform === 'win32' || /^[a-zA-Z]:(?:\/|$)/.test(normHome);
  const isUnderHome = Boolean(
    normHome &&
      (normalized === normHome ||
        normalized.startsWith(`${normHome}/`) ||
        (caseInsensitive &&
          (normalized.toLowerCase() === normHome.toLowerCase() ||
            normalized.toLowerCase().startsWith(`${normHome.toLowerCase()}/`)))),
  );

  if (style === 'parent') {
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 1) return lastSeg;
    const two = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    return visibleWidth(two) <= maxLen ? two : lastSeg;
  }

  // style === 'short'
  if (isUnderHome) {
    if (normalized.length === normHome.length) return '~';
    const rel = normalized.slice(normHome.length + 1);
    const fullTilde = `~/${rel}`;
    const segs = rel.split('/').filter(Boolean);
    if (segs.length <= 2 && visibleWidth(fullTilde) <= maxLen) return fullTilde;
    if (segs.length >= 2) {
      const tail2 = `~/…/${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
      if (visibleWidth(tail2) <= maxLen) return tail2;
    }
    const tail1 = `~/…/${lastSeg}`;
    return visibleWidth(tail1) <= maxLen ? tail1 : lastSeg;
  }

  const segs = normalized.split('/').filter(Boolean);
  if (segs.length <= 2 && visibleWidth(normalized) <= maxLen) return normalized;
  const prefix = /^[a-zA-Z]:/.test(normalized) ? `${segs[0]}/` : '/';
  if (segs.length >= 2) {
    const tail2 = `${prefix}…/${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
    if (visibleWidth(tail2) <= maxLen) return tail2;
  }
  const tail1 = `${prefix}…/${lastSeg}`;
  return visibleWidth(tail1) <= maxLen ? tail1 : lastSeg;
}

function formatDiffCount(n) {
  if (n < 10_000) return String(Math.trunc(n));
  if (n < 999_950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatGitDiffSegment(git, show, palette, color) {
  if (!show?.gitDiff || !git) return '';
  const added = nonNegNumber(git.added) || 0;
  const removed = nonNegNumber(git.removed) || 0;
  if (added === 0 && removed === 0) return '';
  const parts = [];
  if (added > 0) parts.push(fg(`+${formatDiffCount(added)}`, palette.good, color));
  if (removed > 0) parts.push(fg(`-${formatDiffCount(removed)}`, palette.danger, color));
  return parts.join(' ');
}

function formatWorkspaceGitSegment(
  payload,
  git,
  show,
  palette,
  color,
  { withDir = true, withDiff = true, dirStyle = 'short', maxDirLen = 28, maxBranchLen = 22, home = homedir() } = {},
) {
  const rawCwd = payload?.workspace?.current_dir || payload?.cwd || '';
  const dirName = withDir && show.dir && rawCwd ? formatCompactPath(rawCwd, { style: dirStyle, maxLen: maxDirLen, home }) : '';
  const branchRaw = show.git && git?.branch ? sanitizeText(git.branch) : '';
  let branch = branchRaw;
  if (branch && branch.length > maxBranchLen) {
    branch = `${branch.slice(0, Math.max(4, maxBranchLen - 1))}…`;
  }
  const dirtyMark = branch && show.gitDirty && git?.dirty ? fg('*', palette.warn, color) : '';
  const diffSeg = branch && withDiff ? formatGitDiffSegment(git, show, palette, color) : '';
  const diffSuffix = diffSeg ? ` ${diffSeg}` : '';

  if (dirName && branch) {
    return `${fg(dirName, palette.text, color)} ${fg('(', palette.muted, color)}${fg(branch, palette.branch, color)}${dirtyMark}${diffSuffix}${fg(')', palette.muted, color)}`;
  }
  if (branch) {
    return `${fg('git:', palette.muted, color)}${fg(branch, palette.branch, color)}${dirtyMark}${diffSuffix}`;
  }
  if (dirName) {
    return fg(dirName, palette.text, color);
  }
  return '';
}

function formatUsageSummarySegment(
  usageSummary,
  show,
  palette,
  color,
  { withWeek = true, withMonth = true, withTotal = true, withTodayCost = true } = {},
) {
  if (!usageSummary || typeof usageSummary !== 'object') return '';
  const parts = [];
  const today = nonNegNumber(usageSummary.todayTokens);
  const todayCost = nonNegNumber(usageSummary.todayCostUsd);
  const week = nonNegNumber(usageSummary.weekTokens);
  const month = nonNegNumber(usageSummary.monthTokens);
  const total = nonNegNumber(usageSummary.totalTokens);

  const showDayTok = show.todayTokens && today !== null && today > 0;
  const showDayUsd = withTodayCost && show.todayCost && todayCost !== null && todayCost > 0;
  if (showDayTok && showDayUsd) {
    parts.push(
      `${fg('DAY', palette.muted, color)} ${fg(formatCompactTokens(today), palette.text, color)}${fg('/', palette.sep, color)}${fg(formatCompactUsd(todayCost), palette.accent, color)}`,
    );
  } else if (showDayTok) {
    parts.push(`${fg('DAY', palette.muted, color)} ${fg(formatCompactTokens(today), palette.text, color)}`);
  } else if (showDayUsd) {
    parts.push(`${fg('DAY', palette.muted, color)} ${fg(formatCompactUsd(todayCost), palette.accent, color)}`);
  }

  if (withWeek && show.weekTokens && week !== null && week > 0) {
    parts.push(`${fg('WK', palette.muted, color)} ${fg(formatCompactTokens(week), palette.text, color)}`);
  }
  if (withMonth && show.monthTokens && month !== null && month > 0) {
    parts.push(`${fg('MO', palette.muted, color)} ${fg(formatCompactTokens(month), palette.text, color)}`);
  }
  if (withTotal && show.totalTokens && total !== null && total > 0) {
    parts.push(`${fg('ALL', palette.muted, color)} ${fg(formatCompactTokens(total), palette.muted, color)}`);
  }
  return joinWithSep(parts, ' · ', palette, color);
}

function renderMetaLine(payload, width, config, palette, color, git, usageSummary = null, telemetry = null, env = {}, home = homedir()) {
  const { show, dirStyle } = config;
  const activity = classifyAgentActivity(payload);
  const vimBadge = formatVimBadge(payload, show, palette, color);
  const attentionBadge = formatAttentionBadge(activity, show, palette, color);
  const modeBadge = formatModeBadges(payload, show, palette, color);
  const subagentsBadge = formatSubagentsBadge(activity, show, palette, color);
  const tasksBadge = formatTasksBadge(activity, show, palette, color);
  const busySeg = formatBusySegment(activity.isMainBusy, telemetry, show, palette, color);
  const proxyBadge = formatProxyBadge(env, show, palette, color);
  const modelText = show.model ? formatModelName(payload?.model, show.effort) : '';
  const modelSeg = modelText ? fg(modelText, palette.muted, color) : '';

  const usageFull = formatUsageSummarySegment(usageSummary, show, palette, color, { withWeek: true, withMonth: true, withTotal: true, withTodayCost: true });
  const usageNoMo = formatUsageSummarySegment(usageSummary, show, palette, color, { withWeek: true, withMonth: false, withTotal: true, withTodayCost: true });
  const usageDayAll = formatUsageSummarySegment(usageSummary, show, palette, color, { withWeek: false, withMonth: false, withTotal: true, withTodayCost: true });
  const usageDayOnly = formatUsageSummarySegment(usageSummary, show, palette, color, { withWeek: false, withMonth: false, withTotal: false, withTodayCost: true });
  const usageDayTokOnly = formatUsageSummarySegment(usageSummary, show, palette, color, { withWeek: false, withMonth: false, withTotal: false, withTodayCost: false });

  const rightFull = joinWithSep([usageFull, modelSeg], ' │ ', palette, color);
  const rightNoMo = joinWithSep([usageNoMo, modelSeg], ' │ ', palette, color);
  const rightDayAll = joinWithSep([usageDayAll, modelSeg], ' │ ', palette, color);
  const rightDayOnly = joinWithSep([usageDayOnly, modelSeg], ' │ ', palette, color);
  const rightDayTokOnly = joinWithSep([usageDayTokOnly, modelSeg], ' │ ', palette, color);
  const rightModelOnly = modelSeg;

  const wsFull = formatWorkspaceGitSegment(payload, git, show, palette, color, {
    withDir: true,
    withDiff: true,
    dirStyle,
    maxDirLen: 28,
    maxBranchLen: 24,
    home,
  });
  const wsNoDiff = formatWorkspaceGitSegment(payload, git, show, palette, color, {
    withDir: true,
    withDiff: false,
    dirStyle,
    maxDirLen: 28,
    maxBranchLen: 24,
    home,
  });
  const wsShort = formatWorkspaceGitSegment(payload, git, show, palette, color, {
    withDir: true,
    withDiff: false,
    dirStyle: 'name',
    maxDirLen: 18,
    maxBranchLen: 12,
    home,
  });
  const gitOnly = formatWorkspaceGitSegment(payload, git, show, palette, color, {
    withDir: false,
    withDiff: false,
    maxBranchLen: 14,
    home,
  });

  const leftFull = joinWithSep([vimBadge, attentionBadge, modeBadge, subagentsBadge, tasksBadge, busySeg, wsFull, proxyBadge], ' · ', palette, color);
  const leftNoDiff = joinWithSep([vimBadge, attentionBadge, modeBadge, subagentsBadge, tasksBadge, busySeg, wsNoDiff, proxyBadge], ' · ', palette, color);
  const leftShort = joinWithSep([vimBadge, attentionBadge, modeBadge, subagentsBadge, tasksBadge, busySeg, wsShort, proxyBadge], ' · ', palette, color);
  const leftNoProxy = joinWithSep([vimBadge, attentionBadge, modeBadge, subagentsBadge, tasksBadge, busySeg, wsShort], ' · ', palette, color);
  const leftCompact = joinWithSep([vimBadge, attentionBadge, modeBadge, subagentsBadge, busySeg, wsShort || gitOnly], ' · ', palette, color);
  const leftMinimal = attentionBadge || vimBadge || modeBadge || subagentsBadge || busySeg || gitOnly;

  const pairs = [
    [leftFull, rightFull],
    [leftNoDiff, rightFull],
    [leftShort, rightFull],
    [leftFull, rightNoMo],
    [leftNoDiff, rightNoMo],
    [leftShort, rightNoMo],
    [leftFull, rightDayAll],
    [leftNoDiff, rightDayAll],
    [leftShort, rightDayAll],
    [leftFull, rightDayOnly],
    [leftNoDiff, rightDayOnly],
    [leftShort, rightDayOnly],
    [leftFull, rightDayTokOnly],
    [leftNoDiff, rightDayTokOnly],
    [leftShort, rightDayTokOnly],
    [leftFull, rightModelOnly],
    [leftNoDiff, rightModelOnly],
    [leftShort, rightModelOnly],
    [leftNoProxy, rightModelOnly],
    [leftCompact, rightModelOnly],
    [leftMinimal, rightModelOnly],
    ['', rightModelOnly],
  ];

  for (const [left, right] of pairs) {
    const minGap = left && right ? 2 : 0;
    if (visibleWidth(left) + minGap + visibleWidth(right) <= width) {
      return alignRow(left, right, width);
    }
  }
  return alignRow('', rightModelOnly, width);
}

function computeCachePercent(context) {
  const usage = context?.current_usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = nonNegNumber(usage.input_tokens);
  const cached = nonNegNumber(usage.cache_read_input_tokens);
  if (input === null || cached === null || input + cached <= 0) return null;
  return (cached / (input + cached)) * 100;
}

function buildContextSegment(payload, opts, config, palette, color, telemetry) {
  const context = payload?.context_window || {};
  const { show, barStyle, barWidth, colorMode } = config;
  if (!show.context) return '';
  const { warn: contextWarn, danger: contextDanger } = resolveContextThresholds(payload?.model, config);
  const pct = nonNegNumber(context?.used_percentage);
  const size = nonNegNumber(context?.context_window_size);
  const pctText = pct === null ? '--' : `${pct.toFixed(1)}%`;
  const healthyColor = colorMode === 'distinct' ? palette.accent : palette.good;
  const tone =
    pct === null
      ? palette.muted
      : pct >= contextDanger
        ? palette.danger
        : pct >= contextWarn
          ? palette.warn
          : healthyColor;

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
  if (opts.withDelta && show.contextDelta && telemetry?.contextDelta > 0) {
    pieces.push(fg(`+${formatTokens(telemetry.contextDelta)}`, palette.muted, color));
  }
  if (opts.withCapacity && show.capacity && size !== null && size > 0) {
    pieces.push(fg(`(${formatTokens(size)})`, palette.muted, color));
  }
  if (opts.withCompactHint && show.compactHint && pct !== null && pct >= contextDanger) {
    pieces.push(bold(fg('→/compact', palette.danger, color), color));
  }
  return pieces.join(' ');
}

function buildCacheSegment(context, opts, config, palette, color, telemetry) {
  if (!opts.withCache || !config.show.cache) return '';
  const hit = computeCachePercent(context);
  if (hit === null) return '';
  const hitText = `${Math.round(hit)}%`;
  const tone = hit >= 70 ? palette.good : hit >= 30 ? palette.text : palette.warn;
  let seg = `${fg('CACHE', palette.muted, color)} ${fg(hitText, tone, color)}`;

  if (opts.withCacheTtl && config.show.cacheTtl && telemetry && nonNegNumber(telemetry.cacheRemainingSec) !== null) {
    const rem = telemetry.cacheRemainingSec;
    const ttlText = formatCacheTtl(rem);
    const ttlTone = rem <= 30 ? palette.danger : rem <= 90 ? palette.warn : palette.muted;
    seg += `${fg('·', palette.sep, color)}${rem <= 30 ? bold(fg(ttlText, ttlTone, color), color) : fg(ttlText, ttlTone, color)}`;
  }
  return seg;
}

function buildPerfSegment(opts, config, palette, color, telemetry) {
  const parts = [];
  if (opts.withTtft && config.show.ttft) {
    const ttftMs = nonNegNumber(telemetry?.ttftMs);
    if (ttftMs !== null && ttftMs > 0) {
      const ttftSec = ttftMs / 1000;
      const ttftText = formatTtft(ttftMs);
      const tone =
        ttftSec >= config.ttftDangerSec
          ? palette.danger
          : ttftSec >= config.ttftWarnSec
            ? palette.warn
            : ttftSec <= 3
              ? palette.good
              : palette.text;
      const prefix = opts.shortPerf ? '' : `${fg('TTFT', palette.muted, color)} `;
      const val = ttftSec >= config.ttftWarnSec ? bold(fg(ttftText, tone, color), color) : fg(ttftText, tone, color);
      parts.push(`${prefix}${val}`);
    }
  }
  if (opts.withSpeed && config.show.speed) {
    const rate = nonNegNumber(telemetry?.speedTokPerSec);
    if (rate !== null && rate > 0) {
      const label = `${Math.round(rate)}t/s`;
      const tone = rate >= 60 ? palette.accent : rate >= 25 ? palette.text : palette.warn;
      parts.push(fg(label, tone, color));
    }
  }
  return joinWithSep(parts, '·', palette, color);
}

function buildCostSegment(opts, config, palette, color, telemetry) {
  if (!opts.withCost || !config.show.cost) return '';
  const chatCost = nonNegNumber(telemetry?.sessionCostUsd);
  if (chatCost === null || chatCost <= 0) return '';
  return fg(`~${formatUsd(chatCost)}`, palette.text, color);
}

function buildSessionSegment(opts, config, palette, color, telemetry) {
  if (!opts.withSession || !config.show.session) return '';
  const turns = nonNegNumber(telemetry?.sessionTurns);
  const dur = nonNegNumber(telemetry?.sessionDurationSec);
  const parts = [];
  if (dur !== null && dur > 0) parts.push(formatDurationShort(dur));
  if (turns !== null && turns > 0) parts.push(`${turns}t`);
  if (!parts.length) return '';
  return fg(parts.join('·'), palette.muted, color);
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

function renderMetricsRow(
  payload,
  width,
  config,
  palette,
  color,
  now,
  { includePrefix = false, git = null, telemetry = null } = {},
) {
  const context = payload?.context_window || {};
  const quotaEntries = selectQuotaEntries(payload?.quota, payload?.model, config.show);
  const sep = ' │ ';

  const stages = [
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCacheTtl: true, withTtft: true, withSpeed: true, shortPerf: false, withCost: true, withSession: true, withDelta: true, withCompactHint: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCacheTtl: true, withTtft: true, withSpeed: true, shortPerf: true, withCost: true, withSession: false, withDelta: true, withCompactHint: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCacheTtl: true, withTtft: true, withSpeed: true, shortPerf: true, withCost: false, withSession: false, withDelta: true, withCompactHint: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCacheTtl: true, withTtft: true, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: true, withCache: true, withCacheTtl: true, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: true, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: true, withReset: false, withCache: true, withCacheTtl: true, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: false, withReset: true, withCache: true, withCacheTtl: true, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: includePrefix, withBar: true, withQuotaBar: false, withReset: false, withCache: true, withCacheTtl: false, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: includePrefix, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: true, withCacheTtl: false, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCacheTtl: false, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: true, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCacheTtl: false, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: false, shortLabel: false, tight: false },
    { withPrefix: false, withGit: false, withBar: false, withQuotaBar: false, withReset: false, withCache: false, withCacheTtl: false, withTtft: false, withSpeed: false, shortPerf: true, withCost: false, withSession: false, withDelta: false, withCompactHint: false, withCapacity: false, shortLabel: true, tight: true },
  ];

  let chosenLeft = '';
  let chosenRight = '';
  for (const stage of stages) {
    const leftParts = [];
    if (stage.withPrefix) {
      const vimBadge = formatVimBadge(payload, config.show, palette, color);
      if (vimBadge) leftParts.push(vimBadge);
      if (config.show.model) {
        leftParts.push(fg(formatModelName(payload?.model, config.show.effort), palette.text, color));
      }
    }
    if (stage.withGit) {
      const gitSeg = formatWorkspaceGitSegment(payload, git, config.show, palette, color, { withDir: false, maxBranchLen: 16 });
      if (gitSeg) leftParts.push(gitSeg);
    }
    const ctxSeg = buildContextSegment(payload, stage, config, palette, color, telemetry);
    if (ctxSeg) leftParts.push(ctxSeg);
    const cacheSeg = buildCacheSegment(context, stage, config, palette, color, telemetry);
    if (cacheSeg) leftParts.push(cacheSeg);
    const perfSeg = buildPerfSegment(stage, config, palette, color, telemetry);
    if (perfSeg) leftParts.push(perfSeg);
    const costSeg = buildCostSegment(stage, config, palette, color, telemetry);
    if (costSeg) leftParts.push(costSeg);
    const sessionSeg = buildSessionSegment(stage, config, palette, color, telemetry);
    if (sessionSeg) leftParts.push(sessionSeg);

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
    telemetry = null,
    usageSummary = null,
    env = {},
    home = homedir(),
    themeOptions = {},
  } = {},
) {
  const cfg = normalizeConfig(config);
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const width = Math.max(12, Math.floor(nonNegNumber(safePayload.terminal_width) || 80) - 2);
  const resolved = resolvePalette(cfg.theme, themeOptions);
  const colorDepth = detectColorDepth(env);
  const useColor = Boolean(color) && resolved.color && colorDepth !== 'none' ? colorDepth : false;
  const { palette } = resolved;

  if (cfg.preset === 'compact') {
    const row = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
      includePrefix: true,
      git,
      telemetry,
    });
    return row || renderFallback(cfg, { color: useColor, theme: resolved.name });
  }

  if (cfg.preset === 'minimal') {
    const row = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
      includePrefix: false,
      git: null,
      telemetry,
    });
    return row || renderFallback(cfg, { color: useColor, theme: resolved.name });
  }

  const lines = [];
  if (
    cfg.show.hint ||
    cfg.show.vim ||
    cfg.show.mode ||
    cfg.show.subagents ||
    cfg.show.turnTimer ||
    cfg.show.proxy ||
    cfg.show.dir ||
    cfg.show.model ||
    cfg.show.git ||
    cfg.show.todayTokens ||
    cfg.show.todayCost ||
    cfg.show.weekTokens ||
    cfg.show.monthTokens ||
    cfg.show.totalTokens
  ) {
    const meta = renderMetaLine(safePayload, width, cfg, palette, useColor, git, usageSummary, telemetry, env, home);
    if (meta) lines.push(meta);
  }
  const metrics = renderMetricsRow(safePayload, width, cfg, palette, useColor, now, {
    includePrefix: false,
    git: null,
    telemetry,
  });
  if (metrics) lines.push(metrics);

  return lines.length > 0 ? lines.join('\n') : renderFallback(cfg, { color: useColor, theme: resolved.name });
}

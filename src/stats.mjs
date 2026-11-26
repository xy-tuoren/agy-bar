import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { bold, fg, visibleWidth } from './ansi.mjs';
import { configDir } from './config.mjs';
import { estimateCost, formatUsd } from './pricing.mjs';
import { formatTokens, formatTtft, renderBar } from './render.mjs';
import { ledgerPath } from './telemetry.mjs';
import { resolvePalette } from './themes.mjs';

export const PERIOD_NAMES = Object.freeze(['today', '7d', '30d', 'all']);
export const SOURCE_NAMES = Object.freeze(['all', 'cli', 'desktop', 'ledger']);
export const HEATMAP_PALETTE_NAMES = Object.freeze(['purple', 'green', 'cyan', 'amber']);

const HEATMAP_RAMPS = Object.freeze({
  purple: Object.freeze([
    [52, 56, 68],
    [88, 56, 148],
    [129, 86, 212],
    [168, 125, 245],
    [216, 180, 254],
  ]),
  green: Object.freeze([
    [52, 56, 68],
    [14, 90, 56],
    [22, 142, 86],
    [52, 211, 153],
    [167, 243, 208],
  ]),
  cyan: Object.freeze([
    [52, 56, 68],
    [12, 74, 110],
    [2, 132, 199],
    [56, 189, 248],
    [186, 230, 253],
  ]),
  amber: Object.freeze([
    [52, 56, 68],
    [120, 53, 15],
    [180, 83, 9],
    [245, 158, 11],
    [253, 230, 138],
  ]),
});

const HEATMAP_ASCII = ['·', '░', '▒', '▓', '█'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatLocalDate(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function readLedger({ baseDir = configDir(homedir()), filePath = null } = {}) {
  const target = filePath || ledgerPath(baseDir);
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, 'utf8').split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'number') {
        entries.push({ source: 'cli', ...parsed });
      }
    } catch {
      // Skip malformed line without breaking stats.
    }
  }
  return entries;
}

function summarizeOverview(entries, now) {
  const todayDate = new Date(now);
  const todayStart = startOfLocalDay(now);
  const monthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).getTime();
  const yearStart = new Date(todayDate.getFullYear(), 0, 1).getTime();

  const buckets = {
    all: { tokens: 0, turns: 0, sessions: new Set(), days: new Set() },
    today: { tokens: 0, turns: 0, sessions: new Set() },
    month: { tokens: 0, turns: 0, sessions: new Set(), days: new Set() },
    year: { tokens: 0, turns: 0, sessions: new Set(), days: new Set() },
  };
  const dailyMap = new Map();
  const bySource = { cli: 0, desktop: 0 };

  for (const e of entries) {
    const tok = (Number(e.input) || 0) + (Number(e.output) || 0) + (Number(e.cacheRead) || 0) + (Number(e.cacheWrite) || 0);
    if (tok <= 0) continue;
    const dayKey = formatLocalDate(e.ts);
    const sess = e.session || 'unknown';

    buckets.all.tokens += tok;
    buckets.all.turns += 1;
    buckets.all.sessions.add(sess);
    buckets.all.days.add(dayKey);

    if (e.source === 'desktop') bySource.desktop += tok;
    else bySource.cli += tok;

    dailyMap.set(dayKey, (dailyMap.get(dayKey) || 0) + tok);

    if (e.ts >= todayStart) {
      buckets.today.tokens += tok;
      buckets.today.turns += 1;
      buckets.today.sessions.add(sess);
    }
    if (e.ts >= monthStart) {
      buckets.month.tokens += tok;
      buckets.month.turns += 1;
      buckets.month.sessions.add(sess);
      buckets.month.days.add(dayKey);
    }
    if (e.ts >= yearStart) {
      buckets.year.tokens += tok;
      buckets.year.turns += 1;
      buckets.year.sessions.add(sess);
      buckets.year.days.add(dayKey);
    }
  }

  // Compute current & longest active-day streaks.
  const activeDates = [...dailyMap.keys()].sort();
  let longestStreak = 0;
  let running = 0;
  let prevMs = null;
  for (const dayStr of activeDates) {
    const ms = Date.parse(`${dayStr}T00:00:00Z`);
    if (prevMs !== null && ms - prevMs === 86_400_000) running += 1;
    else running = 1;
    if (running > longestStreak) longestStreak = running;
    prevMs = ms;
  }

  let currentStreak = 0;
  const cursor = new Date(todayStart);
  // Allow streak to start from today or yesterday if user hasn't sent a prompt yet today.
  if (!dailyMap.has(formatLocalDate(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (dailyMap.has(formatLocalDate(cursor.getTime()))) {
    currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let peakDay = null;
  for (const [day, tokens] of dailyMap.entries()) {
    if (!peakDay || tokens > peakDay.tokens) peakDay = { day, tokens };
  }

  const monthActiveDays = Math.max(1, buckets.month.days.size);

  return {
    all: {
      tokens: buckets.all.tokens,
      turns: buckets.all.turns,
      sessions: buckets.all.sessions.size,
      activeDays: buckets.all.days.size,
    },
    today: {
      tokens: buckets.today.tokens,
      turns: buckets.today.turns,
      sessions: buckets.today.sessions.size,
    },
    month: {
      monthLabel: MONTH_LABELS[todayDate.getMonth()],
      tokens: buckets.month.tokens,
      turns: buckets.month.turns,
      sessions: buckets.month.sessions.size,
      avgPerActiveDay: Math.round(buckets.month.tokens / monthActiveDays),
    },
    year: {
      year: todayDate.getFullYear(),
      tokens: buckets.year.tokens,
      turns: buckets.year.turns,
      sessions: buckets.year.sessions.size,
      activeDays: buckets.year.days.size,
    },
    streaks: { current: currentStreak, longest: longestStreak },
    peakDay,
    bySource,
    dailyTokens: Object.fromEntries([...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function aggregateStats(entries, { period = '7d', modelFilter = null, now = Date.now(), sourceLabel = 'ledger' } = {}) {
  if (!PERIOD_NAMES.includes(period)) {
    throw new Error(`Invalid period "${period}". Choose one of: ${PERIOD_NAMES.join(', ')}`);
  }

  const needle = modelFilter ? String(modelFilter).toLowerCase() : null;
  const modelFilteredAll = needle
    ? entries.filter((e) => String(e.model || '').toLowerCase().includes(needle))
    : entries;

  const overview = summarizeOverview(modelFilteredAll, now);

  let cutoff = 0;
  if (period === 'today') cutoff = startOfLocalDay(now);
  else if (period === '7d') cutoff = startOfLocalDay(now) - 6 * 24 * 60 * 60 * 1000;
  else if (period === '30d') cutoff = startOfLocalDay(now) - 29 * 24 * 60 * 60 * 1000;

  const filtered = modelFilteredAll.filter((e) => e.ts >= cutoff);

  const totals = {
    turns: filtered.length,
    sessions: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
    costUsd: 0,
    cacheSavedUsd: 0,
    unpricedTurns: 0,
    ttftSum: 0,
    ttftCount: 0,
    speedSum: 0,
    speedCount: 0,
    quota5hStart: null,
    quota5hEnd: null,
    quotaWeeklyStart: null,
    quotaWeeklyEnd: null,
  };

  const byModel = new Map();
  const byDay = new Map();

  const sorted = [...filtered].sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    const input = Number(e.input) || 0;
    const output = Number(e.output) || 0;
    const cacheRead = Number(e.cacheRead) || 0;
    const cacheWrite = Number(e.cacheWrite) || 0;
    const thinking = Number(e.thinking) || 0;
    const est = estimateCost({ model: e.model, input, output, cacheRead, cacheWrite });

    if (e.session) totals.sessions.add(e.session);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.thinking += thinking;
    if (est.priced) {
      totals.costUsd += est.costUsd;
      totals.cacheSavedUsd += est.cacheSavedUsd;
    } else {
      totals.unpricedTurns += 1;
    }
    if (typeof e.ttftMs === 'number' && Number.isFinite(e.ttftMs) && e.ttftMs > 0) {
      totals.ttftSum += e.ttftMs;
      totals.ttftCount += 1;
    }
    if (typeof e.tokPerSec === 'number' && Number.isFinite(e.tokPerSec) && e.tokPerSec > 0) {
      totals.speedSum += e.tokPerSec;
      totals.speedCount += 1;
    }
    if (typeof e.quota5h === 'number' && Number.isFinite(e.quota5h)) {
      if (totals.quota5hStart === null) totals.quota5hStart = e.quota5h;
      totals.quota5hEnd = e.quota5h;
    }
    if (typeof e.quotaWeekly === 'number' && Number.isFinite(e.quotaWeekly)) {
      if (totals.quotaWeeklyStart === null) totals.quotaWeeklyStart = e.quotaWeekly;
      totals.quotaWeeklyEnd = e.quotaWeekly;
    }

    const mKey = e.effort ? `${e.model || 'Unknown'} (${e.effort})` : e.model || 'Unknown';
    if (!byModel.has(mKey)) {
      byModel.set(mKey, {
        model: mKey,
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        costUsd: 0,
        priced: est.priced,
        ttftSum: 0,
        ttftCount: 0,
        speedSum: 0,
        speedCount: 0,
      });
    }
    const m = byModel.get(mKey);
    m.turns += 1;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    if (est.priced) {
      m.costUsd += est.costUsd;
      m.priced = true;
    }
    if (typeof e.ttftMs === 'number' && e.ttftMs > 0) {
      m.ttftSum += e.ttftMs;
      m.ttftCount += 1;
    }
    if (typeof e.tokPerSec === 'number' && e.tokPerSec > 0) {
      m.speedSum += e.tokPerSec;
      m.speedCount += 1;
    }

    const day = formatLocalDate(e.ts);
    if (!byDay.has(day)) {
      byDay.set(day, { day, turns: 0, tokens: 0, output: 0, costUsd: 0 });
    }
    const d = byDay.get(day);
    d.turns += 1;
    d.tokens += input + output + cacheRead + cacheWrite;
    d.output += output;
    if (est.priced) d.costUsd += est.costUsd;
  }

  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const cacheHitPct =
    totals.input + totals.cacheRead > 0
      ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 1000) / 10
      : null;

  const models = [...byModel.values()]
    .map((m) => ({
      model: m.model,
      turns: m.turns,
      totalTokens: m.input + m.output + m.cacheRead,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheHitPct: m.input + m.cacheRead > 0 ? Math.round((m.cacheRead / (m.input + m.cacheRead)) * 100) : null,
      avgTtftMs: m.ttftCount > 0 ? Math.round(m.ttftSum / m.ttftCount) : null,
      avgTokPerSec: m.speedCount > 0 ? Math.round((m.speedSum / m.speedCount) * 10) / 10 : null,
      costUsd: m.costUsd,
      priced: m.priced,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return {
    period,
    source: sourceLabel,
    overview,
    turns: totals.turns,
    sessions: totals.sessions.size,
    totalTokens,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    thinking: totals.thinking,
    cacheHitPct,
    avgTtftMs: totals.ttftCount > 0 ? Math.round(totals.ttftSum / totals.ttftCount) : null,
    avgTokPerSec: totals.speedCount > 0 ? Math.round((totals.speedSum / totals.speedCount) * 10) / 10 : null,
    costUsd: totals.costUsd,
    cacheSavedUsd: totals.cacheSavedUsd,
    unpricedTurns: totals.unpricedTurns,
    quotaDelta: {
      fiveHour:
        totals.quota5hStart !== null && totals.quota5hEnd !== null
          ? Math.round((totals.quota5hEnd - totals.quota5hStart) * 100)
          : null,
      weekly:
        totals.quotaWeeklyStart !== null && totals.quotaWeeklyEnd !== null
          ? Math.round((totals.quotaWeeklyEnd - totals.quotaWeeklyStart) * 100)
          : null,
    },
    models,
    days,
  };
}

function padRight(text, len) {
  const s = String(text);
  const w = visibleWidth(s);
  return w >= len ? s : s + ' '.repeat(len - w);
}

function padLeft(text, len) {
  const s = String(text);
  const w = visibleWidth(s);
  return w >= len ? s : ' '.repeat(len - w) + s;
}

function renderCardGrid(cards, p, useColor) {
  const colW = 19;
  const top = fg(`┌${cards.map(() => '─'.repeat(colW)).join('┬')}┐`, p.sep, useColor);
  const bot = fg(`└${cards.map(() => '─'.repeat(colW)).join('┴')}┘`, p.sep, useColor);
  const pipe = fg('│', p.sep, useColor);

  const rowLine = (cells) => `${pipe}${cells.map((c) => ` ${padRight(c, colW - 2)} `).join(pipe)}${pipe}`;
  return [
    top,
    rowLine(cards.map((c) => fg(c.label, p.muted, useColor))),
    rowLine(cards.map((c) => bold(fg(c.value, c.color || p.text, useColor), useColor))),
    rowLine(cards.map((c) => fg(c.sub, p.muted, useColor))),
    bot,
  ];
}

export function renderActivityHeatmap(
  dailyTokens = {},
  { now = Date.now(), weeks = 26, heatmapPalette = 'purple', color = true, theme = 'auto' } = {},
) {
  const resolved = resolvePalette(theme);
  const useColor = color && resolved.color;
  const p = resolved.palette;
  const ramp = HEATMAP_RAMPS[heatmapPalette] || HEATMAP_RAMPS.purple;

  const end = new Date(startOfLocalDay(now));
  // Align grid end to Saturday (day 6) of the current week so columns are Sunday..Saturday.
  const endAligned = new Date(end);
  endAligned.setDate(endAligned.getDate() + (6 - endAligned.getDay()));

  const start = new Date(endAligned);
  start.setDate(start.getDate() - (weeks * 7 - 1));

  const values = [];
  const grid = Array.from({ length: 7 }, () => new Array(weeks).fill(null));
  const colDates = new Array(weeks);

  const cur = new Date(start);
  for (let w = 0; w < weeks; w++) {
    colDates[w] = new Date(cur);
    for (let dow = 0; dow < 7; dow++) {
      const ts = cur.getTime();
      if (ts <= end.getTime()) {
        const key = formatLocalDate(ts);
        const val = dailyTokens[key] || 0;
        grid[dow][w] = val;
        if (val > 0) values.push(val);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  const maxVal = values.length > 0 ? Math.max(...values) : 0;
  const levelFor = (val) => {
    if (val === null) return -1;
    if (val <= 0 || maxVal <= 0) return 0;
    // Log-compressed intensity so both normal days and massive 200M+ spikes stay legible.
    const ratio = Math.log1p(val) / Math.log1p(maxVal);
    if (ratio >= 0.82) return 4;
    if (ratio >= 0.58) return 3;
    if (ratio >= 0.32) return 2;
    return 1;
  };

  // Build month axis header above grid.
  const axisChars = new Array(weeks * 2).fill(' ');
  let lastMonth = -1;
  let lastLabelEnd = -1;
  for (let w = 0; w < weeks; w++) {
    const m = colDates[w].getMonth();
    const pos = w * 2;
    if (m !== lastMonth && pos >= lastLabelEnd + 1) {
      const lbl = MONTH_LABELS[m];
      if (pos + lbl.length <= axisChars.length) {
        for (let k = 0; k < lbl.length; k++) axisChars[pos + k] = lbl[k];
        lastLabelEnd = pos + lbl.length;
      }
      lastMonth = m;
    }
  }

  const lines = [];
  lines.push(`     ${fg(axisChars.join('').trimEnd(), p.muted, useColor)}`);

  const dayNames = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   '];
  for (let dow = 0; dow < 7; dow++) {
    const cells = [];
    for (let w = 0; w < weeks; w++) {
      const lvl = levelFor(grid[dow][w]);
      if (lvl < 0) {
        cells.push('  ');
      } else if (useColor) {
        cells.push(`${fg('■', ramp[lvl], true)} `);
      } else {
        cells.push(`${HEATMAP_ASCII[lvl]} `);
      }
    }
    lines.push(`${fg(dayNames[dow], p.muted, useColor)}  ${cells.join('').trimEnd()}`);
  }

  const legendCells = [0, 1, 2, 3, 4]
    .map((lvl) => (useColor ? fg('■', ramp[lvl], true) : HEATMAP_ASCII[lvl]))
    .join(' ');
  lines.push(`     ${fg('Less', p.muted, useColor)} ${legendCells} ${fg('More', p.muted, useColor)}`);
  return lines;
}

export function formatStatsReport(
  report,
  { color = true, theme = 'auto', heatmapPalette = 'purple', columns = process.stdout.columns || 100, now = Date.now() } = {},
) {
  const resolved = resolvePalette(theme);
  const useColor = color && resolved.color;
  const p = resolved.palette;
  const ruleW = 81;

  const lines = [];
  const srcNote = report.source ? ` · source=${report.source}` : '';
  lines.push(bold(fg(`agy-bar token stats (${report.period}${srcNote})`, p.accent, useColor), useColor));

  const ov = report.overview;
  if (!ov || (ov.all.turns === 0 && report.turns === 0)) {
    lines.push(fg('─'.repeat(ruleW), p.sep, useColor));
    lines.push(fg('No local Antigravity token usage found yet.', p.muted, useColor));
    lines.push(fg('Run a few turns in Antigravity CLI, or ensure Node >= 22.13 for full conversation DB history.', p.muted, useColor));
    return lines.join('\n');
  }

  // 4-card overview strip (All-Time / Today / This Month / This Year)
  const cards = [
    {
      label: 'ALL-TIME TOTAL',
      value: formatTokens(ov.all.tokens),
      sub: `${ov.all.sessions} sessions`,
      color: p.branch,
    },
    {
      label: 'TODAY',
      value: formatTokens(ov.today.tokens),
      sub: `${ov.today.sessions} sessions`,
      color: p.accent,
    },
    {
      label: `THIS MONTH (${ov.month.monthLabel})`,
      value: formatTokens(ov.month.tokens),
      sub: `avg ${formatTokens(ov.month.avgPerActiveDay)}/d`,
      color: p.good,
    },
    {
      label: `YEAR (${ov.year.year})`,
      value: formatTokens(ov.year.tokens),
      sub: `${ov.year.activeDays}d · ${ov.streaks.current}d streak`,
      color: p.text,
    },
  ];
  lines.push(...renderCardGrid(cards, p, useColor));

  // Terminal Token Activity Heatmap
  const heatWeeks = columns >= 116 ? 52 : columns >= 74 ? 32 : 20;
  const peakNote = ov.peakDay ? ` · Peak ${ov.peakDay.day} (${formatTokens(ov.peakDay.tokens)})` : '';
  const streakNote = ov.streaks.longest > 0 ? ` · Best streak ${ov.streaks.longest}d` : '';
  lines.push('');
  lines.push(
    bold(fg(`Token Activity (${heatWeeks}w)`, p.text, useColor), useColor) +
      fg(`${peakNote}${streakNote}`, p.muted, useColor),
  );
  lines.push(...renderActivityHeatmap(ov.dailyTokens, { now, weeks: heatWeeks, heatmapPalette, color: useColor, theme }));

  // Focused period breakdown
  lines.push('');
  lines.push(fg('─'.repeat(ruleW), p.sep, useColor));
  const cacheText = report.cacheHitPct !== null ? `${report.cacheHitPct}%` : '--';
  const ttftText = report.avgTtftMs !== null ? formatTtft(report.avgTtftMs) : '--';
  const speedText = report.avgTokPerSec !== null ? `${report.avgTokPerSec} tok/s` : '--';
  const costText = `${formatUsd(report.costUsd)}${report.cacheSavedUsd > 0 ? ` (saved ${formatUsd(report.cacheSavedUsd)} via cache)` : ''}`;

  lines.push(
    `${fg(`Period (${report.period}):`, p.muted, useColor)} ` +
      `${bold(fg(formatTokens(report.totalTokens), p.text, useColor), useColor)} ` +
      `${fg(`· ${report.sessions} sessions · ${report.turns} reqs · TTFT ${ttftText} · ${speedText}`, p.muted, useColor)}`,
  );
  lines.push(
    `${fg('Breakdown: ', p.muted, useColor)}` +
      `${fg(`in ${formatTokens(report.input)} · out ${formatTokens(report.output)} · cache ${formatTokens(report.cacheRead)} (${cacheText} hit)`, p.text, useColor)}` +
      (report.thinking > 0 ? fg(` · think ${formatTokens(report.thinking)}`, p.muted, useColor) : ''),
  );
  lines.push(
    `${fg('Est. API:  ', p.muted, useColor)}${fg(costText, p.good, useColor)}` +
      (report.unpricedTurns > 0 ? fg(` · ${report.unpricedTurns} unpriced`, p.muted, useColor) : ''),
  );

  if (ov.bySource.cli > 0 && ov.bySource.desktop > 0) {
    const sum = ov.bySource.cli + ov.bySource.desktop;
    const cliPct = Math.round((ov.bySource.cli / sum) * 100);
    lines.push(
      `${fg('Sources:   ', p.muted, useColor)}` +
        `${fg(`CLI ${formatTokens(ov.bySource.cli)} (${cliPct}%)`, p.accent, useColor)} ` +
        `${fg('│', p.sep, useColor)} ` +
        `${fg(`Desktop ${formatTokens(ov.bySource.desktop)} (${100 - cliPct}%)`, p.branch, useColor)}`,
    );
  }

  const qParts = [];
  if (report.quotaDelta.fiveHour !== null) {
    const sign = report.quotaDelta.fiveHour > 0 ? '+' : '';
    qParts.push(`5h ${sign}${report.quotaDelta.fiveHour}%`);
  }
  if (report.quotaDelta.weekly !== null) {
    const sign = report.quotaDelta.weekly > 0 ? '+' : '';
    qParts.push(`7d ${sign}${report.quotaDelta.weekly}%`);
  }
  if (qParts.length > 0) {
    lines.push(`${fg('Quota Δ:   ', p.muted, useColor)}${fg(qParts.join(' │ '), p.text, useColor)} ${fg('(observed locally)', p.muted, useColor)}`);
  }

  if (report.models.length > 0) {
    lines.push('');
    lines.push(bold(fg('By Model', p.text, useColor), useColor));
    lines.push(
      fg(
        `${padRight('Model', 26)} ${padLeft('Reqs', 6)} ${padLeft('Tokens', 9)} ${padLeft('Cache', 7)} ${padLeft('TTFT', 7)} ${padLeft('Speed', 9)} ${padLeft('Est.', 9)}`,
        p.muted,
        useColor,
      ),
    );
    for (const m of report.models) {
      lines.push(
        `${fg(padRight(m.model, 26), p.text, useColor)} ` +
          `${fg(padLeft(m.turns, 6), p.muted, useColor)} ` +
          `${fg(padLeft(formatTokens(m.totalTokens), 9), p.text, useColor)} ` +
          `${fg(padLeft(m.cacheHitPct !== null ? `${m.cacheHitPct}%` : '--', 7), p.good, useColor)} ` +
          `${fg(padLeft(m.avgTtftMs !== null ? formatTtft(m.avgTtftMs) : '--', 7), p.muted, useColor)} ` +
          `${fg(padLeft(m.avgTokPerSec !== null ? `${m.avgTokPerSec}t/s` : '--', 9), p.accent, useColor)} ` +
          `${fg(padLeft(m.priced ? formatUsd(m.costUsd) : 'n/a', 9), p.text, useColor)}`,
      );
    }
  }

  if (report.days.length > 0) {
    const maxTokens = Math.max(...report.days.map((d) => d.tokens), 1);
    lines.push('');
    lines.push(bold(fg('Daily Activity', p.text, useColor), useColor));
    for (const d of report.days.slice(-14)) {
      const bar = renderBar(d.tokens / maxTokens, {
        width: 24,
        style: 'smooth',
        fillColor: p.accent,
        trackColor: p.track,
        color: useColor,
      });
      lines.push(
        `${fg(d.day, p.muted, useColor)}  ${bar}  ${fg(padLeft(formatTokens(d.tokens), 7), p.text, useColor)}  ` +
          `${fg(`${padLeft(d.turns, 4)} reqs`, p.muted, useColor)}  ${fg(formatUsd(d.costUsd), p.good, useColor)}`,
      );
    }
  }

  lines.push(fg('─'.repeat(ruleW), p.sep, useColor));
  lines.push(fg('* Read-only local scan (never reads chat text). API cost uses public reference rates.', p.muted, useColor));
  return lines.join('\n');
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { bold, fg } from './ansi.mjs';
import { configDir } from './config.mjs';
import { estimateCost, formatUsd } from './pricing.mjs';
import { formatTokens, renderBar } from './render.mjs';
import { ledgerPath } from './telemetry.mjs';
import { resolvePalette } from './themes.mjs';

export const PERIOD_NAMES = Object.freeze(['today', '7d', '30d', 'all']);

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatLocalDate(ts) {
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
        entries.push(parsed);
      }
    } catch {
      // Skip malformed line without breaking stats.
    }
  }
  return entries;
}

export function aggregateStats(entries, { period = '7d', modelFilter = null, now = Date.now() } = {}) {
  if (!PERIOD_NAMES.includes(period)) {
    throw new Error(`Invalid period "${period}". Choose one of: ${PERIOD_NAMES.join(', ')}`);
  }

  let cutoff = 0;
  if (period === 'today') cutoff = startOfLocalDay(now);
  else if (period === '7d') cutoff = startOfLocalDay(now) - 6 * 24 * 60 * 60 * 1000;
  else if (period === '30d') cutoff = startOfLocalDay(now) - 29 * 24 * 60 * 60 * 1000;

  const needle = modelFilter ? String(modelFilter).toLowerCase() : null;
  const filtered = entries.filter((e) => {
    if (e.ts < cutoff) return false;
    if (needle && !String(e.model || '').toLowerCase().includes(needle)) return false;
    return true;
  });

  const totals = {
    turns: filtered.length,
    sessions: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    cacheSavedUsd: 0,
    unpricedTurns: 0,
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
    const est = estimateCost({ model: e.model, input, output, cacheRead, cacheWrite });

    if (e.session) totals.sessions.add(e.session);
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    if (est.priced) {
      totals.costUsd += est.costUsd;
      totals.cacheSavedUsd += est.cacheSavedUsd;
    } else {
      totals.unpricedTurns += 1;
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
    d.tokens += input + output + cacheRead;
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
      avgTokPerSec: m.speedCount > 0 ? Math.round((m.speedSum / m.speedCount) * 10) / 10 : null,
      costUsd: m.costUsd,
      priced: m.priced,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return {
    period,
    turns: totals.turns,
    sessions: totals.sessions.size,
    totalTokens,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    cacheHitPct,
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
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function padLeft(text, len) {
  const s = String(text);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function formatStatsReport(report, { color = true, theme = 'auto' } = {}) {
  const resolved = resolvePalette(theme);
  const useColor = color && resolved.color;
  const p = resolved.palette;

  const lines = [];
  lines.push(bold(fg(`agy-bar usage stats (${report.period})`, p.accent, useColor), useColor));
  lines.push(fg('─'.repeat(76), p.sep, useColor));

  if (report.turns === 0) {
    lines.push(fg('No local CLI usage recorded for this period yet.', p.muted, useColor));
    lines.push(fg('Once agy-bar is active in Antigravity CLI, turns are logged locally to ledger.jsonl.', p.muted, useColor));
    return lines.join('\n');
  }

  const cacheText = report.cacheHitPct !== null ? `${report.cacheHitPct}%` : '--';
  const speedText = report.avgTokPerSec !== null ? `${report.avgTokPerSec} tok/s` : '--';
  const costText = `${formatUsd(report.costUsd)}${report.cacheSavedUsd > 0 ? ` (saved ${formatUsd(report.cacheSavedUsd)} via cache)` : ''}`;

  lines.push(
    `${fg('Sessions:', p.muted, useColor)} ${fg(String(report.sessions), p.text, useColor)}  ` +
      `${fg('Turns:', p.muted, useColor)} ${fg(String(report.turns), p.text, useColor)}  ` +
      `${fg('Avg Speed:', p.muted, useColor)} ${fg(speedText, p.accent, useColor)}`,
  );
  lines.push(
    `${fg('Tokens:  ', p.muted, useColor)} ${bold(fg(formatTokens(report.totalTokens), p.text, useColor), useColor)} ` +
      `${fg(`(in ${formatTokens(report.input)} · out ${formatTokens(report.output)} · cache ${formatTokens(report.cacheRead)}, hit ${cacheText})`, p.muted, useColor)}`,
  );
  lines.push(
    `${fg('Est. API:', p.muted, useColor)} ${fg(costText, p.good, useColor)}` +
      (report.unpricedTurns > 0 ? fg(` · ${report.unpricedTurns} unpriced turns`, p.muted, useColor) : ''),
  );

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
    lines.push(`${fg('Quota Δ: ', p.muted, useColor)} ${fg(qParts.join(' │ '), p.text, useColor)} ${fg('(net change observed locally)', p.muted, useColor)}`);
  }

  // Per-model breakdown
  lines.push('');
  lines.push(bold(fg('By Model', p.text, useColor), useColor));
  lines.push(
    fg(
      `${padRight('Model', 30)} ${padLeft('Turns', 6)} ${padLeft('Tokens', 9)} ${padLeft('Cache', 7)} ${padLeft('Speed', 10)} ${padLeft('Est.', 9)}`,
      p.muted,
      useColor,
    ),
  );
  for (const m of report.models) {
    const row =
      `${fg(padRight(m.model, 30), p.text, useColor)} ` +
      `${fg(padLeft(m.turns, 6), p.muted, useColor)} ` +
      `${fg(padLeft(formatTokens(m.totalTokens), 9), p.text, useColor)} ` +
      `${fg(padLeft(m.cacheHitPct !== null ? `${m.cacheHitPct}%` : '--', 7), p.good, useColor)} ` +
      `${fg(padLeft(m.avgTokPerSec !== null ? `${m.avgTokPerSec}t/s` : '--', 10), p.accent, useColor)} ` +
      `${fg(padLeft(m.priced ? formatUsd(m.costUsd) : 'n/a', 9), p.text, useColor)}`;
    lines.push(row);
  }

  // Daily bar chart
  if (report.days.length > 0) {
    const maxTokens = Math.max(...report.days.map((d) => d.tokens), 1);
    lines.push('');
    lines.push(bold(fg('Daily Activity', p.text, useColor), useColor));
    for (const d of report.days.slice(-14)) {
      const bar = renderBar(d.tokens / maxTokens, {
        width: 24,
        style: 'blocks',
        fillColor: p.accent,
        trackColor: p.track,
        color: useColor,
      });
      lines.push(
        `${fg(d.day, p.muted, useColor)}  ${bar}  ${fg(padLeft(formatTokens(d.tokens), 7), p.text, useColor)}  ` +
          `${fg(`${padLeft(d.turns, 3)} turns`, p.muted, useColor)}  ${fg(formatUsd(d.costUsd), p.good, useColor)}`,
      );
    }
  }

  lines.push(fg('─'.repeat(76), p.sep, useColor));
  lines.push(fg('* Estimated API cost uses public reference rates for subscription ROI & carpool tracking.', p.muted, useColor));
  return lines.join('\n');
}

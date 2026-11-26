import { bold, clipPlain, detectColorDepth, fg, visibleWidth } from './ansi.mjs';
import { loadConfig } from './config.mjs';
import { formatUsd } from './pricing.mjs';
import { formatReset, formatTtft, renderBar } from './render.mjs';
import { listSessions } from './telemetry.mjs';
import { resolvePalette } from './themes.mjs';

const QUOTA_LABELS = Object.freeze({
  'gemini-5h': '5h',
  'gemini-weekly': '7d',
  '3p-5h': 'Claude 5h',
  '3p-weekly': 'Claude 7d',
  'gemini-argon-wtu-weekly': 'Argon 7d',
});

function formatAge(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m ago`;
}

function formatTtl(lastActivityAt, ttlSec, now) {
  if (typeof lastActivityAt !== 'number') return '--';
  const rem = Math.max(0, Math.round((ttlSec * 1000 - (now - lastActivityAt)) / 1000));
  if (rem === 0) return 'exp';
  if (rem < 60) return `${rem}s`;
  return `${Math.floor(rem / 60)}m${String(rem % 60).padStart(2, '0')}s`;
}

function padRight(text, len) {
  const s = String(text || '');
  const w = visibleWidth(s);
  if (w > len) {
    const clipped = clipPlain(s, Math.max(1, len - 1));
    const rem = Math.max(0, len - visibleWidth(clipped) - 1);
    return `${clipped}…${' '.repeat(rem)}`;
  }
  return s + ' '.repeat(Math.max(0, len - w));
}

function padLeft(text, len) {
  const s = String(text || '');
  const w = visibleWidth(s);
  return w >= len ? s : ' '.repeat(len - w) + s;
}

export function renderMonitorFrame(
  sessions,
  { now = Date.now(), config = loadConfig(), color = true, env = process.env, columns = process.stdout.columns || 98 } = {},
) {
  const resolved = resolvePalette(config.theme, { env });
  const colorDepth = detectColorDepth(env);
  const useColor = Boolean(color) && resolved.color && colorDepth !== 'none' ? colorDepth : false;
  const p = resolved.palette;
  const lines = [];
  const ruleWidth = Math.min(104, Math.max(76, columns || 98));

  const activeCount = sessions.filter((s) => s.ageMs <= 5 * 60 * 1000).length;
  lines.push(
    bold(fg('agy-bar monitor', p.accent, useColor), useColor) +
      fg(` · ${sessions.length} recent CLI session${sessions.length === 1 ? '' : 's'} (${activeCount} active) · Ctrl+C to quit`, p.muted, useColor),
  );
  lines.push(fg('─'.repeat(ruleWidth), p.sep, useColor));

  // Show latest observed global quota from most recent session that has quota data.
  const latestQuota = sessions.find((s) => s.quota)?.quota;
  if (latestQuota) {
    const qItems = [];
    for (const [id, q] of Object.entries(latestQuota)) {
      const pct = Math.round(q.remaining * 100);
      const tone = pct <= config.quotaDanger ? p.danger : pct <= config.quotaWarn ? p.warn : p.good;
      const bar = renderBar(q.remaining, { width: 6, style: config.barStyle, fillColor: tone, trackColor: p.track, color: useColor });
      const reset = formatReset(q, now);
      const label = QUOTA_LABELS[id] || id;
      qItems.push(`${fg(label, p.muted, useColor)} ${bar} ${fg(`${pct}%`, tone, useColor)}${reset ? fg(` (${reset})`, p.muted, useColor) : ''}`);
    }
    if (qItems.length > 0) {
      lines.push(`${fg('Quota: ', p.muted, useColor)}${qItems.join(fg(' │ ', p.sep, useColor))}`);
      lines.push(fg('─'.repeat(ruleWidth), p.sep, useColor));
    }
  }

  if (sessions.length === 0) {
    lines.push(fg('No active agy CLI sessions detected yet.', p.muted, useColor));
    lines.push(fg('Start one or more `agy` terminals with agy-bar installed to monitor them live here.', p.muted, useColor));
    return lines.join('\n');
  }

  lines.push(
    fg(
      `${padRight('State', 10)} ${padRight('Workspace / Branch', 22)} ${padRight('Model', 17)} ${padRight('Context', 14)} ${padRight('Cache / TTL', 12)} ${padLeft('TTFT', 6)} ${padLeft('Speed', 7)} ${padLeft('Cost', 7)}`,
      p.muted,
      useColor,
    ),
  );

  const healthyCtxColor = config.colorMode === 'distinct' ? p.accent : p.good;

  for (const s of sessions) {
    const dot = s.isBusy ? fg('●', p.warn, useColor) : s.ageMs <= 5 * 60 * 1000 ? fg('●', p.good, useColor) : fg('○', p.muted, useColor);
    const stateLabel = padRight(s.agentState || 'idle', 8);
    const ws = s.workspaceName || s.sessionId.slice(0, 10);
    const branchPart = s.branch ? `:${s.branch}${s.dirty ? '*' : ''}` : '';
    const wsCell = padRight(`${ws}${branchPart}`, 22);
    const modelCell = padRight(s.model || '--', 17);

    const pct = typeof s.usedPct === 'number' ? s.usedPct : null;
    const ctxTone =
      pct === null ? p.muted : pct >= config.contextDanger ? p.danger : pct >= config.contextWarn ? p.warn : healthyCtxColor;
    const ctxBar = renderBar(pct === null ? 0 : pct / 100, {
      width: 6,
      style: config.barStyle,
      fillColor: ctxTone,
      trackColor: p.track,
      color: useColor,
    });
    const ctxText = padLeft(pct !== null ? `${pct.toFixed(0)}%` : '--', 4);

    const cachePct = typeof s.cacheHitPct === 'number' ? `${Math.round(s.cacheHitPct)}%` : '--';
    const ttl = formatTtl(s.lastActivityAt, config.cacheTtlSec, now);
    const cacheCell = padRight(`${cachePct}·${ttl}`, 12);
    const ttftCell = padLeft(typeof s.lastTtftMs === 'number' && s.lastTtftMs > 0 ? formatTtft(s.lastTtftMs) : '--', 6);
    const speedCell = padLeft(typeof s.lastSpeedTokPerSec === 'number' ? `${Math.round(s.lastSpeedTokPerSec)}t/s` : '--', 7);
    const costCell = padLeft(typeof s.sessionCostUsd === 'number' && s.sessionCostUsd > 0 ? formatUsd(s.sessionCostUsd) : '--', 7);

    lines.push(
      `${dot} ${fg(stateLabel, s.isBusy ? p.warn : p.text, useColor)} ` +
        `${fg(wsCell, p.branch, useColor)} ` +
        `${fg(modelCell, p.text, useColor)} ` +
        `${ctxBar} ${fg(ctxText, ctxTone, useColor)}   ` +
        `${fg(cacheCell, ttl === 'exp' ? p.danger : p.muted, useColor)} ` +
        `${fg(ttftCell, p.text, useColor)} ` +
        `${fg(speedCell, p.accent, useColor)} ` +
        `${fg(costCell, p.good, useColor)} ${fg(formatAge(s.ageMs), p.muted, useColor)}`,
    );
  }

  return lines.join('\n');
}

export async function startMonitor({ intervalMs = 1000, once = false, color = true, baseDir } = {}) {
  const renderOnce = () => {
    const config = loadConfig();
    const sessions = listSessions({ baseDir, prune: true });
    return renderMonitorFrame(sessions, { config, color });
  };

  if (once || !process.stdout.isTTY) {
    process.stdout.write(`${renderOnce()}\n`);
    return;
  }

  const draw = () => {
    process.stdout.write('\x1b[2J\x1b[H' + renderOnce() + '\n');
  };

  draw();
  await new Promise((resolve) => {
    const timer = setInterval(draw, Math.max(250, intervalMs));
    const cleanup = () => {
      clearInterval(timer);
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

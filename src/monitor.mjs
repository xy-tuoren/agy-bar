import { bold, fg } from './ansi.mjs';
import { loadConfig } from './config.mjs';
import { formatReset, renderBar } from './render.mjs';
import { listSessions } from './telemetry.mjs';
import { resolvePalette } from './themes.mjs';

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
  return s.length > len ? `${s.slice(0, Math.max(1, len - 1))}…` : s + ' '.repeat(len - s.length);
}

function padLeft(text, len) {
  const s = String(text || '');
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

export function renderMonitorFrame(sessions, { now = Date.now(), config = loadConfig(), color = true } = {}) {
  const resolved = resolvePalette(config.theme);
  const useColor = color && resolved.color;
  const p = resolved.palette;
  const lines = [];

  const activeCount = sessions.filter((s) => s.ageMs <= 5 * 60 * 1000).length;
  lines.push(
    bold(fg('agy-bar monitor', p.accent, useColor), useColor) +
      fg(` · ${sessions.length} recent CLI session${sessions.length === 1 ? '' : 's'} (${activeCount} active) · Ctrl+C to quit`, p.muted, useColor),
  );
  lines.push(fg('─'.repeat(92), p.sep, useColor));

  // Show latest observed global quota from most recent session that has quota data.
  const latestQuota = sessions.find((s) => s.quota)?.quota;
  if (latestQuota) {
    const qItems = [];
    for (const [id, q] of Object.entries(latestQuota)) {
      const pct = Math.round(q.remaining * 100);
      const tone = pct <= config.quotaDanger ? p.danger : pct <= config.quotaWarn ? p.warn : p.good;
      const bar = renderBar(q.remaining, { width: 6, style: config.barStyle, fillColor: tone, trackColor: p.track, color: useColor });
      const reset = formatReset(q, now);
      qItems.push(`${fg(id, p.muted, useColor)} ${bar} ${fg(`${pct}%`, tone, useColor)}${reset ? fg(` (${reset})`, p.muted, useColor) : ''}`);
    }
    if (qItems.length > 0) {
      lines.push(`${fg('Quota: ', p.muted, useColor)}${qItems.join(fg(' │ ', p.sep, useColor))}`);
      lines.push(fg('─'.repeat(92), p.sep, useColor));
    }
  }

  if (sessions.length === 0) {
    lines.push(fg('No active agy CLI sessions detected yet.', p.muted, useColor));
    lines.push(fg('Start one or more `agy` terminals with agy-bar installed to monitor them live here.', p.muted, useColor));
    return lines.join('\n');
  }

  lines.push(
    fg(
      `${padRight('State', 10)} ${padRight('Workspace / Branch', 24)} ${padRight('Model', 18)} ${padRight('Context', 15)} ${padRight('Cache / TTL', 14)} ${padLeft('Speed', 8)}`,
      p.muted,
      useColor,
    ),
  );

  for (const s of sessions) {
    const dot = s.isBusy ? fg('●', p.warn, useColor) : s.ageMs <= 5 * 60 * 1000 ? fg('●', p.good, useColor) : fg('○', p.muted, useColor);
    const stateLabel = padRight(s.agentState || 'idle', 8);
    const ws = s.workspaceName || s.sessionId.slice(0, 10);
    const branchPart = s.branch ? `:${s.branch}${s.dirty ? '*' : ''}` : '';
    const wsCell = padRight(`${ws}${branchPart}`, 24);
    const modelCell = padRight(s.model || '--', 18);

    const pct = typeof s.usedPct === 'number' ? s.usedPct : null;
    const ctxTone =
      pct === null ? p.muted : pct >= config.contextDanger ? p.danger : pct >= config.contextWarn ? p.warn : p.accent;
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
    const cacheCell = padRight(`${cachePct} · ${ttl}`, 14);
    const speedCell = padLeft(typeof s.lastSpeedTokPerSec === 'number' ? `${Math.round(s.lastSpeedTokPerSec)}t/s` : '--', 8);

    lines.push(
      `${dot} ${fg(stateLabel, s.isBusy ? p.warn : p.text, useColor)} ` +
        `${fg(wsCell, p.branch, useColor)} ` +
        `${fg(modelCell, p.text, useColor)} ` +
        `${ctxBar} ${fg(ctxText, ctxTone, useColor)}    ` +
        `${fg(cacheCell, ttl === 'exp' ? p.danger : p.muted, useColor)} ` +
        `${fg(speedCell, p.accent, useColor)}  ${fg(formatAge(s.ageMs), p.muted, useColor)}`,
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

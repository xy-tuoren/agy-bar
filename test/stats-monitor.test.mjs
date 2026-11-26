import assert from 'node:assert/strict';
import test from 'node:test';
import { stripAnsi } from '../src/ansi.mjs';
import { renderMonitorFrame } from '../src/monitor.mjs';
import { estimateCost, formatUsd } from '../src/pricing.mjs';
import { aggregateStats, formatStatsReport, renderActivityHeatmap } from '../src/stats.mjs';

test('estimateCost computes billed API cost, cache savings, and marks unknown models unpriced', () => {
  const opts = { useLocalSources: false };
  const sonnet = estimateCost(
    {
      model: 'Claude Sonnet 4.6',
      input: 100_000,
      output: 20_000,
      cacheRead: 500_000,
    },
    opts,
  );
  assert.equal(sonnet.priced, true);
  // 0.1*3 + 0.02*15 + 0.5*0.3 = 0.3 + 0.3 + 0.15 = 0.75
  assert.ok(Math.abs(sonnet.costUsd - 0.75) < 1e-6);
  // cache saved = 0.5 * (3.0 - 0.3) = 1.35
  assert.ok(Math.abs(sonnet.cacheSavedUsd - 1.35) < 1e-6);

  const neon = estimateCost({ model: 'Gemini 4 Neon', input: 1_000_000, output: 100_000 }, opts);
  assert.equal(neon.priced, true);
  // 1.0*3.0 + 0.1*15.0 = 4.5
  assert.ok(Math.abs(neon.costUsd - 4.5) < 1e-6);

  const unknown = estimateCost({ model: 'Mystery Local LLM', input: 50_000, output: 10_000 }, opts);
  assert.equal(unknown.priced, false);
  assert.equal(unknown.costUsd, 0);
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(12.345), '$12.35');
});

test('aggregateStats and formatStatsReport summarize periods, model filters, quota delta, and daily bars', () => {
  const now = new Date('2026-11-26T12:00:00Z').getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const entries = [
    {
      ts: now - 10 * dayMs,
      session: 'old-sess',
      model: 'Gemini 4 Carbon',
      effort: 'high',
      input: 50_000,
      output: 5_000,
      cacheRead: 200_000,
      tokPerSec: 120,
      quota5h: 0.95,
      quotaWeekly: 0.9,
    },
    {
      ts: now - 2 * dayMs,
      session: 'sess-1',
      model: 'Gemini 4 Carbon',
      effort: 'high',
      input: 40_000,
      output: 8_000,
      cacheRead: 360_000,
      tokPerSec: 140,
      quota5h: 0.85,
      quotaWeekly: 0.72,
    },
    {
      ts: now - 1000,
      session: 'sess-2',
      model: 'Claude Sonnet 4.6',
      effort: 'medium',
      input: 30_000,
      output: 4_000,
      cacheRead: 170_000,
      tokPerSec: 90,
      quota5h: 0.75,
      quotaWeekly: 0.68,
    },
  ];

  const report7d = aggregateStats(entries, { period: '7d', now });
  assert.equal(report7d.turns, 2);
  assert.equal(report7d.sessions, 2);
  assert.equal(report7d.models.length, 2);
  assert.equal(report7d.quotaDelta.fiveHour, -10);
  assert.equal(report7d.quotaDelta.weekly, -4);
  assert.equal(report7d.avgTokPerSec, 115);

  const claudeOnly = aggregateStats(entries, { period: 'all', modelFilter: 'claude', now });
  assert.equal(claudeOnly.turns, 1);
  assert.equal(claudeOnly.models[0].model, 'Claude Sonnet 4.6 (medium)');

  const text = stripAnsi(formatStatsReport(report7d, { color: false, now, columns: 120 }));
  assert.match(text, /agy-bar token stats \(7d/);
  assert.match(text, /ALL-TIME TOTAL/);
  assert.match(text, /TODAY/);
  assert.match(text, /Token Activity \(52w\)/);
  assert.match(text, /By Model/);
  assert.match(text, /Daily Activity/);
  assert.match(text, /saved \$/);
  assert.match(text, /Quota Δ:/);

  const heatColored = renderActivityHeatmap({ '2026-11-26': 200_000_000, '2026-11-25': 50_000_000 }, { now, weeks: 20, heatmapPalette: 'purple', color: true, env: { COLORTERM: 'truecolor' } });
  assert.equal(heatColored.length, 9); // month axis + 7 days + legend
  assert.ok(heatColored.some((line) => line.includes('\x1b[38;2;216;180;254m■')));

  // Light theme uses inverted light-background heatmap palette and Apple_Terminal uses 256-color SGR.
  const heatLight = renderActivityHeatmap({ '2026-11-26': 200_000_000 }, { now, weeks: 20, heatmapPalette: 'purple', color: true, theme: 'slate-light', env: { COLORTERM: 'truecolor' } });
  assert.ok(heatLight.some((line) => line.includes('\x1b[38;2;88;28;135m■')));
  const heat256 = renderActivityHeatmap({ '2026-11-26': 200_000_000 }, { now, weeks: 20, heatmapPalette: 'purple', color: true, env: { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' } });
  assert.ok(heat256.some((line) => line.includes('\x1b[38;5;')));
  assert.ok(!heat256.some((line) => line.includes('\x1b[38;2;')));

  // 4-card overview grid fits inside standard 80-column terminals (77 cols) without wrapping.
  const cardTopLine = text.split('\n').find((l) => l.startsWith('┌'));
  assert.ok(cardTopLine && cardTopLine.length <= 80, `Card grid width ${cardTopLine?.length} exceeded 80 cols`);
});

test('renderMonitorFrame displays active multi-CLI sessions, CJK alignment, cost, and friendly quota labels', () => {
  const now = 1_795_600_000_000;
  const colored = renderMonitorFrame(
    [
      {
        sessionId: 'sess-1',
        ageMs: 2_000,
        isBusy: true,
        agentState: 'working',
        workspaceName: '中文项目',
        branch: 'main',
        dirty: true,
        model: 'Gemini 4 Carbon',
        usedPct: 48.2,
        cacheHitPct: 88,
        lastActivityAt: now - 45_000,
        lastSpeedTokPerSec: 145,
        sessionCostUsd: 1.24,
        quota: {
          'gemini-5h': { remaining: 0.82, reset_in_seconds: 7200 },
          'gemini-weekly': { remaining: 0.61, reset_in_seconds: 259200 },
        },
      },
      {
        sessionId: 'sess-2',
        ageMs: 90_000,
        isBusy: false,
        agentState: 'idle',
        workspaceName: 'web-app',
        branch: 'feat/auth',
        dirty: false,
        model: 'Claude Sonnet 4.6',
        usedPct: 76.0,
        cacheHitPct: 64,
        lastActivityAt: now - 350_000,
        lastSpeedTokPerSec: 88,
        sessionCostUsd: 0.42,
        quota: null,
      },
    ],
    { now, color: true, env: { COLORTERM: 'truecolor' }, config: { theme: 'slate-dark', colorMode: 'health', barStyle: 'segments', cacheTtlSec: 300, contextWarn: 70, contextDanger: 88, quotaWarn: 25, quotaDanger: 10 } },
  );

  // Health colorMode uses good green (52;211;153) for healthy 48.2% context bar.
  assert.ok(colored.includes('\x1b[38;2;52;211;153m▮▮▮'));

  const frame = stripAnsi(colored);
  assert.match(frame, /2 recent CLI sessions \(2 active\)/);
  assert.match(frame, /5h .*82%/);
  assert.match(frame, /7d .*61%/);
  assert.match(frame, /中文项目:main\*/);
  assert.match(frame, /145t\/s/);
  assert.match(frame, /\$1\.24/);
  assert.match(frame, /web-app:feat\/auth/);
  assert.match(frame, /exp/);

  // Verify waiting confirmation, running subagents, and error states render distinctly in monitor.
  const multiState = stripAnsi(
    renderMonitorFrame(
      [
        { sessionId: 's-confirm', ageMs: 1000, activityKind: 'confirm', agentState: 'reviewing', workspaceName: 'app-a', model: 'Gemini 4 Neon', usedPct: 30 },
        { sessionId: 's-subs', ageMs: 1000, activityKind: 'subagents', runningSubagents: 4, agentState: 'idle', workspaceName: 'app-b', model: 'Gemini 4 Neon', usedPct: 40 },
        { sessionId: 's-err', ageMs: 1000, activityKind: 'error', agentState: 'error', workspaceName: 'app-c', model: 'Gemini 4 Neon', usedPct: 50 },
      ],
      { now, color: false, config: { theme: 'slate-dark', colorMode: 'health', barStyle: 'segments', cacheTtlSec: 300, contextWarn: 70, contextDanger: 88, quotaWarn: 25, quotaDanger: 10 } },
    ),
  );
  assert.match(multiState, /1 waiting/);
  assert.match(multiState, /\? confirm/);
  assert.match(multiState, /● sub:4/);
  assert.match(multiState, /✗ error/);
});

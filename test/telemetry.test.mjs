import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readLedger } from '../src/stats.mjs';
import {
  armPayloadCapture,
  listSessions,
  maybeCaptureRedactedPayload,
  readCapturedPayload,
  recordTelemetry,
  redactPayload,
} from '../src/telemetry.mjs';

test('tracks turn speed (tok/s), 5-min cache TTL countdown, context delta, and appends to ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-tel-'));
  try {
    const t0 = 1_795_600_000_000;
    const basePayload = {
      conversation_id: 'conv-1001',
      workspace: { current_dir: '/Users/dev/project-a' },
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon (High)', effort: 'high' },
      quota: {
        'gemini-5h': { remaining_fraction: 0.9, reset_in_seconds: 9000 },
        'gemini-weekly': { remaining_fraction: 0.7, reset_in_seconds: 200000 },
      },
    };

    // Turn starts: agent enters working state with initial totals.
    const r1 = recordTelemetry(
      {
        ...basePayload,
        agent_state: 'working',
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 10.0,
          total_input_tokens: 10000,
          total_output_tokens: 0,
          current_usage: { input_tokens: 10000, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      { now: t0, baseDir: dir, git: { branch: 'main', dirty: false } },
    );
    assert.equal(r1.speedTokPerSec, null);
    assert.equal(r1.cacheRemainingSec, 300);

    // 10 seconds later, agent finishes producing 1,500 output tokens -> 150 tok/s.
    const r2 = recordTelemetry(
      {
        ...basePayload,
        agent_state: 'idle',
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 12.5,
          total_input_tokens: 22000,
          total_output_tokens: 1500,
          current_usage: { input_tokens: 12000, output_tokens: 1500, cache_read_input_tokens: 80000 },
        },
      },
      { now: t0 + 10_000, baseDir: dir, git: { branch: 'main', dirty: true } },
    );
    assert.equal(r2.speedTokPerSec, 150);
    assert.equal(r2.turnDurationMs, 10_000);
    assert.equal(r2.contextDelta, 25_000);
    assert.equal(r2.cacheRemainingSec, 300);

    // 250 seconds later with no new turn -> cache TTL counts down to 50s.
    const r3 = recordTelemetry(
      {
        ...basePayload,
        agent_state: 'idle',
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 12.5,
          total_input_tokens: 22000,
          total_output_tokens: 1500,
          current_usage: { input_tokens: 12000, output_tokens: 1500, cache_read_input_tokens: 80000 },
        },
      },
      { now: t0 + 260_000, baseDir: dir },
    );
    assert.equal(r3.cacheRemainingSec, 50);
    assert.equal(r3.cacheExpired, false);

    // After 5+ minutes -> cache expires cleanly.
    const r4 = recordTelemetry(
      {
        ...basePayload,
        agent_state: 'idle',
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 12.5,
          total_input_tokens: 22000,
          total_output_tokens: 1500,
          current_usage: { input_tokens: 12000, output_tokens: 1500, cache_read_input_tokens: 80000 },
        },
      },
      { now: t0 + 320_000, baseDir: dir },
    );
    assert.equal(r4.cacheRemainingSec, 0);
    assert.equal(r4.cacheExpired, true);

    // Exactly one turn appended to ledger.
    const ledger = readLedger({ baseDir: dir });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].model, 'Gemini 4 Carbon');
    assert.equal(ledger[0].output, 1500);
    assert.equal(ledger[0].tokPerSec, 150);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolates concurrent CLI sessions and ignores resumed baseline spikes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-multi-'));
  try {
    const t0 = 1_795_600_000_000;

    // Resumed session with 45,000 prior output tokens shouldn't log a fake 45K delta.
    recordTelemetry(
      {
        conversation_id: 'session-a',
        agent_state: 'idle',
        workspace: { current_dir: '/repo/alpha' },
        model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon' },
        context_window: {
          context_window_size: 1_000_000,
          used_percentage: 38.0,
          total_input_tokens: 180000,
          total_output_tokens: 45000,
          current_usage: { input_tokens: 5000, output_tokens: 400, cache_read_input_tokens: 90000 },
        },
      },
      { now: t0, baseDir: dir, git: { branch: 'main', dirty: false } },
    );

    recordTelemetry(
      {
        conversation_id: 'session-b',
        agent_state: 'working',
        workspace: { current_dir: '/repo/beta' },
        model: { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
        context_window: {
          context_window_size: 200_000,
          used_percentage: 62.0,
          total_input_tokens: 40000,
          total_output_tokens: 0,
          current_usage: null,
        },
      },
      { now: t0 + 1000, baseDir: dir, git: { branch: 'feat/ui', dirty: true } },
    );

    assert.equal(readLedger({ baseDir: dir }).length, 0);

    const sessions = listSessions({ baseDir: dir, now: t0 + 2000 });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 'session-b');
    assert.equal(sessions[0].branch, 'feat/ui');
    assert.equal(sessions[1].sessionId, 'session-a');
    assert.equal(sessions[1].model, 'Gemini 4 Neon');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('armPayloadCapture and maybeCaptureRedactedPayload redact PII and disarm after one capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-dbg-'));
  try {
    const sample = {
      email: 'alice@example.com',
      conversation_id: 'b9d667f9-6d2b-4a0f-96ad-90b57a7d6f5a',
      conversation_title: 'Secret internal roadmap',
      workspace: { current_dir: '/Users/alice/work/repo' },
      context_window: { total_input_tokens: 12000, used_percentage: 22.1 },
    };

    const red = redactPayload(sample, '/Users/alice');
    assert.equal(red.email, '***@***');
    assert.equal(red.conversation_id, 'b9d667f9…');
    assert.equal(red.workspace.current_dir, '~/work/repo');
    assert.equal(red.context_window.total_input_tokens, 12000);
    assert.match(red.conversation_title, /^\[TITLE len=/);

    assert.equal(maybeCaptureRedactedPayload(sample, { baseDir: dir, home: '/Users/alice' }), false);
    armPayloadCapture({ baseDir: dir });
    assert.equal(maybeCaptureRedactedPayload(sample, { baseDir: dir, home: '/Users/alice' }), true);
    // One-shot: second call does nothing until re-armed.
    assert.equal(maybeCaptureRedactedPayload(sample, { baseDir: dir, home: '/Users/alice' }), false);

    const saved = readCapturedPayload({ baseDir: dir });
    assert.equal(saved.payload.email, '***@***');
    assert.equal(saved.payload.workspace.current_dir, '~/work/repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefers exact DB stepTiming TTFT and streaming decode speed over wall-clock fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-dbtiming-'));
  try {
    const t0 = 1_795_686_170_000;
    const res = recordTelemetry(
      {
        conversation_id: 'b9d667f9-6d2b-4a0f-96ad-90b57a7d6f5a',
        agent_state: 'idle',
        model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', effort: 'xhigh' },
        context_window: {
          context_window_size: 1_048_576,
          used_percentage: 26.5,
          total_input_tokens: 280000,
          total_output_tokens: 939,
          current_usage: { input_tokens: 2400, output_tokens: 939, cache_read_input_tokens: 284000 },
        },
      },
      {
        now: t0,
        baseDir: dir,
        stepTiming: {
          idx: 2572,
          ttftMs: 10_100,
          streamMs: 5_700,
          totalMs: 15_800,
          completedAtMs: t0 - 45_000,
          outputTokens: 939,
        },
      },
    );
    assert.equal(res.ttftMs, 10_100);
    // Pure streaming decode speed: 939 / 5.7 = 164.7 tok/s (not diluted by 10.1s TTFT!)
    assert.equal(res.speedTokPerSec, 164.7);
    // Cache TTL uses exact DB completedAtMs (300 - 45 = 255s remaining)
    assert.equal(res.cacheRemainingSec, 255);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

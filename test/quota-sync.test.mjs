import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  extractAccountKey,
  isBucketResetDue,
  isEpochSentinelReset,
  isWeeklyBucketBlocking,
  mergeQuotaSnapshots,
  quotaCachePath,
  syncSharedQuota,
} from '../src/quota-sync.mjs';

test('syncSharedQuota propagates newer reset windows and lower same-window usage across idle terminals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-quota-'));
  try {
    const now = Date.parse('2026-11-27T02:58:00Z');

    // Terminal B already refreshed into the new 5h window (94%, resets 07:15:16Z).
    const freshFromB = {
      'gemini-5h': { remaining_fraction: 0.938, reset_time: '2026-11-27T07:15:16Z', reset_in_seconds: 15436 },
      'gemini-weekly': { remaining_fraction: 0.632, reset_time: '2026-12-03T07:11:37Z', reset_in_seconds: 533617 },
      '3p-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
    };
    const resB = syncSharedQuota(freshFromB, { baseDir: dir, now });
    assert.equal(resB['gemini-5h'].remaining_fraction, 0.938);

    // Terminal A is still sitting idle with a stale expired 0% window (02:11:37Z).
    const staleFromA = {
      'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T02:11:37Z', reset_in_seconds: 0 },
      'gemini-weekly': { remaining_fraction: 0.65, reset_time: '2026-12-03T07:11:37Z', reset_in_seconds: 533617 },
      '3p-5h': { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 },
    };
    const resA = syncSharedQuota(staleFromA, { baseDir: dir, now: now + 10_000 });
    assert.equal(resA['gemini-5h'].remaining_fraction, 0.938);
    assert.equal(resA['gemini-5h'].reset_time, '2026-11-27T07:15:16Z');
    assert.equal(resA['gemini-5h'].reset_in_seconds, 15426);
    // Same weekly window: picks strictly lower 0.632 over stale 0.65.
    assert.equal(resA['gemini-weekly'].remaining_fraction, 0.632);

    // Terminal C is in the same 07:15:16Z window but hasn't made a call recently (stale 98.4%).
    const staleSameWindowC = {
      'gemini-5h': { remaining_fraction: 0.984, reset_time: '2026-11-27T07:15:16Z', reset_in_seconds: 15420 },
    };
    const mtimeBefore = statSync(quotaCachePath(dir)).mtimeMs;
    const resC = syncSharedQuota(staleSameWindowC, { baseDir: dir, now: now + 16_000 });
    assert.equal(resC['gemini-5h'].remaining_fraction, 0.938);
    // No unnecessary disk write when incoming payload had no fresher data.
    assert.equal(statSync(quotaCachePath(dir)).mtimeMs, mtimeBefore);

    // Terminal B completes another turn down to 91.2% -> updates shared cache.
    const newerFromB = {
      'gemini-5h': { remaining_fraction: 0.912, reset_time: '2026-11-27T07:15:16Z', reset_in_seconds: 15400 },
    };
    const resB2 = syncSharedQuota(newerFromB, { baseDir: dir, now: now + 36_000 });
    assert.equal(resB2['gemini-5h'].remaining_fraction, 0.912);
    const resA2 = syncSharedQuota(staleFromA, { baseDir: dir, now: now + 40_000 });
    assert.equal(resA2['gemini-5h'].remaining_fraction, 0.912);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handles epoch-zero sentinels, weekly cap blocking, and account key isolation without storing PII', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-quota-edge-'));
  try {
    const now = Date.parse('2026-11-27T03:00:00Z');

    // Epoch sentinel 1970-01-01 is NOT due.
    const unusedClaude = { remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', reset_in_seconds: 0 };
    assert.equal(isEpochSentinelReset(unusedClaude), true);
    assert.equal(isBucketResetDue(unusedClaude, now), false);

    // Active Claude window in another terminal overrides unused 1970 sentinel.
    syncSharedQuota(
      { '3p-5h': { remaining_fraction: 0.72, reset_time: '2026-11-27T06:00:00Z', reset_in_seconds: 10800 } },
      { baseDir: dir, now },
    );
    const adopted = syncSharedQuota({ '3p-5h': unusedClaude }, { baseDir: dir, now: now + 5_000 });
    assert.equal(adopted['3p-5h'].remaining_fraction, 0.72);
    assert.equal(adopted['3p-5h'].reset_time, '2026-11-27T06:00:00Z');

    // Weekly cap blocking helper.
    const weeklyHasQuota = {
      'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T02:55:00Z' },
      'gemini-weekly': { remaining_fraction: 0.65, reset_time: '2026-12-03T07:11:37Z' },
    };
    assert.equal(isBucketResetDue(weeklyHasQuota['gemini-5h'], now), true);
    assert.equal(isWeeklyBucketBlocking('gemini-5h', weeklyHasQuota, now), false);

    const weeklyExhausted = {
      'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T02:55:00Z' },
      'gemini-weekly': { remaining_fraction: 0, reset_time: '2026-12-03T07:11:37Z' },
    };
    assert.equal(isWeeklyBucketBlocking('gemini-5h', weeklyExhausted, now), true);

    // Account key hashes email (never plaintext on disk) and isolates accounts.
    const keyA = extractAccountKey({ user_email: 'Alice@Example.com' });
    const keyB = extractAccountKey({ user_email: 'bob@example.com' });
    assert.notEqual(keyA, keyB);
    assert.ok(!keyA.includes('alice'));

    const isoDir = mkdtempSync(join(tmpdir(), 'agy-bar-quota-acct-'));
    try {
      syncSharedQuota(
        { 'gemini-5h': { remaining_fraction: 0.2, reset_time: '2026-11-27T07:00:00Z' } },
        { baseDir: isoDir, now, accountKey: keyA },
      );
      const rawDisk = readFileSync(quotaCachePath(isoDir), 'utf8');
      assert.ok(!rawDisk.toLowerCase().includes('alice'));

      const bobMerged = syncSharedQuota(
        { 'gemini-5h': { remaining_fraction: 0.95, reset_time: '2026-11-27T07:00:00Z' } },
        { baseDir: isoDir, now, accountKey: keyB },
      );
      assert.equal(bobMerged['gemini-5h'].remaining_fraction, 0.95);
    } finally {
      rmSync(isoDir, { recursive: true, force: true });
    }

    // mergeQuotaSnapshots picks freshest across multiple session objects.
    const merged = mergeQuotaSnapshots(
      [
        {
          observedAt: now,
          quota: { 'gemini-5h': { remaining: 0.98, reset_time: '2026-11-27T07:15:16Z' } },
        },
        {
          observedAt: now - 30_000,
          quota: { 'gemini-5h': { remaining: 0.94, reset_time: '2026-11-27T07:15:16Z' } },
        },
      ],
      now,
    );
    assert.equal(merged['gemini-5h'].remaining_fraction, 0.94);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

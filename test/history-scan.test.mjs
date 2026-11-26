import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  computeUsageSummary,
  getOrRefreshUsageSummary,
  parseStepUsageMetadata,
  resolveModelEnum,
  saveUsageSummary,
} from '../src/history-scan.mjs';

function encodeVarint(n) {
  let v = BigInt(n);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function pbVarint(field, val) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function pbBytes(field, payload) {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}

function pbTimestamp(sec, nanos = 0) {
  return Buffer.concat([pbVarint(1, sec), pbVarint(2, nanos)]);
}

test('resolveModelEnum maps known Antigravity model IDs and falls back cleanly', () => {
  assert.equal(resolveModelEnum(1535), 'Gemini 4 Neon');
  assert.equal(resolveModelEnum(1530), 'Gemini 4 Hydrogen');
  assert.equal(resolveModelEnum(1427), 'Gemini 4 Carbon');
  assert.equal(resolveModelEnum(1417), 'Gemini 4 Argon');
  assert.equal(resolveModelEnum(9999), 'Model #9999');
});

test('parseStepUsageMetadata extracts model, token counts, thinking tokens, TTFT, and decode speed', () => {
  const usage = Buffer.concat([
    pbVarint(1, 1535),
    pbVarint(2, 2600),
    pbVarint(3, 1200),
    pbVarint(5, 280000),
    pbVarint(9, 450),
    pbVarint(10, 750),
  ]);
  const meta = Buffer.concat([
    pbBytes(1, pbTimestamp(1795686158, 0)),
    pbBytes(6, pbTimestamp(1795686164, 0)),
    pbBytes(7, pbTimestamp(1795686167, 0)),
    pbBytes(8, pbTimestamp(1795686167, 0)),
    pbBytes(9, usage),
  ]);

  const parsed = parseStepUsageMetadata(meta, { session: 'b9d667f9-6d2b', source: 'cli' });
  assert.ok(parsed);
  assert.equal(parsed.model, 'Gemini 4 Neon');
  assert.equal(parsed.source, 'cli');
  assert.equal(parsed.input, 2600);
  assert.equal(parsed.output, 1200);
  assert.equal(parsed.cacheRead, 280000);
  assert.equal(parsed.thinking, 750);
  assert.equal(parsed.ttftMs, 6000);
  assert.equal(parsed.tokPerSec, 150);
});

test('parseStepUsageMetadata ignores empty or malformed metadata safely', () => {
  assert.equal(parseStepUsageMetadata(null), null);
  assert.equal(parseStepUsageMetadata(Buffer.from([0xff, 0xff])), null);
});

test('getOrRefreshUsageSummary returns cached totals and increments live deltas without rescanning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-usum-'));
  try {
    const now = new Date('2026-11-26T12:00:00Z').getTime();
    const initial = computeUsageSummary(
      [
        { ts: now - 3 * 86_400_000, input: 100_000, output: 10_000, cacheRead: 900_000 },
        { ts: now - 1000, input: 50_000, output: 5_000, cacheRead: 450_000 },
      ],
      { now },
    );
    assert.equal(initial.todayTokens, 505_000);
    assert.equal(initial.totalTokens, 1_515_000);
    saveUsageSummary(initial, { baseDir: dir });

    const bumped = await getOrRefreshUsageSummary({
      baseDir: dir,
      now: now + 5000,
      deltaTokens: 100_000,
      allowScan: false,
    });
    assert.equal(bumped.todayTokens, 605_000);
    assert.equal(bumped.totalTokens, 1_615_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

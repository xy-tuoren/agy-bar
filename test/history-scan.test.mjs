import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  computeUsageSummary,
  getOrRefreshUsageSummary,
  parseStepUsageMetadata,
  readConversationParentMap,
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
        { session: 'conv-old', model: 'Gemini 4 Neon', ts: now - 10 * 86_400_000, input: 200_000, output: 20_000, cacheRead: 780_000 },
        { session: 'conv-live-123456', model: 'Gemini 4 Carbon', ts: now - 3 * 86_400_000, input: 100_000, output: 10_000, cacheRead: 900_000 },
        { session: 'conv-live-123456', model: 'Gemini 4 Carbon', ts: now - 1000, input: 50_000, output: 5_000, cacheRead: 450_000 },
      ],
      { now },
    );
    assert.equal(initial.todayTokens, 505_000);
    assert.equal(initial.weekTokens, 1_515_000);
    assert.equal(initial.monthTokens, 2_515_000);
    assert.equal(initial.totalTokens, 2_515_000);
    assert.ok(initial.todayCostUsd > 0.18 && initial.todayCostUsd < 0.21);
    assert.ok(initial.recentSessionCosts['conv-live-123456'] > initial.todayCostUsd);
    saveUsageSummary(initial, { baseDir: dir });

    const bumped = await getOrRefreshUsageSummary({
      baseDir: dir,
      now: now + 5000,
      sessionId: 'conv-live-123456789',
      deltaTokens: 100_000,
      deltaCostUsd: 0.25,
      allowScan: false,
    });
    assert.equal(bumped.todayTokens, 605_000);
    assert.equal(bumped.weekTokens, 1_615_000);
    assert.equal(bumped.monthTokens, 2_615_000);
    assert.equal(bumped.totalTokens, 2_615_000);
    assert.equal(bumped.todayCostUsd, Math.round((initial.todayCostUsd + 0.25) * 10_000) / 10_000);
    assert.equal(
      bumped.sessionCostUsd,
      Math.round((initial.recentSessionCosts['conv-live-123456'] + 0.25) * 10_000) / 10_000,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeUsageSummary rolls up nested subagent costs into parent session without double-counting todayCostUsd', async () => {
  const now = new Date('2026-11-26T12:00:00Z').getTime();
  const entries = [
    { session: 'parent-aaaa-1111', model: 'Gemini 4 Neon', ts: now - 5000, input: 1_000_000, output: 0, cacheRead: 0 }, // $3.00
    { session: 'child-bbbb-22222', model: 'Gemini 4 Neon', ts: now - 4000, input: 500_000, output: 0, cacheRead: 0 }, // $1.50
    { session: 'grand-cccc-33333', model: 'Gemini 4 Neon', ts: now - 3000, input: 200_000, output: 0, cacheRead: 0 }, // $0.60
  ];
  const parentMap = {
    'child-bbbb-22222': 'parent-aaaa-1111',
    'grand-cccc-33333': 'child-bbbb-22222',
  };

  const summary = computeUsageSummary(entries, { now, parentMap });
  // Today total is exact ($3.00 + $1.50 + $0.60 = $5.10), NEVER double-counted.
  assert.equal(summary.todayCostUsd, 5.1);
  // Parent session includes itself + child + grandchild ($5.10).
  assert.equal(summary.recentSessionCosts['parent-aaaa-1111'], 5.1);
  // Middle child includes itself + grandchild ($2.10).
  assert.equal(summary.recentSessionCosts['child-bbbb-22222'], 2.1);
  // Leaf grandchild has only itself ($0.60).
  assert.equal(summary.recentSessionCosts['grand-cccc-33333'], 0.6);

  // Verify active subagents shorten cache TTL from 5m to 20s.
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-subrefresh-'));
  try {
    saveUsageSummary(summary, { baseDir: dir });
    const refreshed = await getOrRefreshUsageSummary({
      baseDir: dir,
      now: now + 25_000,
      sessionId: 'parent-aaaa-1111',
      hasRunningSubagents: true,
      allowScan: false,
      fallbackEntries: [
        ...entries,
        { session: 'child-bbbb-22222', model: 'Gemini 4 Neon', ts: now + 24_000, input: 500_000, output: 0, cacheRead: 0 },
      ],
      parentMap,
    });
    assert.equal(refreshed.sessionCostUsd, 6.6);
    assert.equal(refreshed.todayCostUsd, 6.6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Verify readConversationParentMap reads SQLite parent_conversation_id on Node >= 22.13 (no-op on Node 20).
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    DatabaseSync = null;
  }
  if (DatabaseSync) {
    const dbDir = mkdtempSync(join(tmpdir(), 'agy-bar-sumdb-'));
    try {
      const dbPath = join(dbDir, 'conversation_summaries.db');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL DEFAULT "")');
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('sub-1111-2222-3333', 'root-aaaa-bbbb-cccc');
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('root-aaaa-bbbb-cccc', '');
      db.close();

      const map = await readConversationParentMap({ dbPaths: [dbPath] });
      assert.equal(map.get('sub-1111-2222-33'), 'root-aaaa-bbbb-c');
      assert.equal(map.size, 1);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  }
});

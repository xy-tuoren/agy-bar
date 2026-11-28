import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFileAtomic } from '../src/fs-atomic.mjs';
import {
  getDbVersionStamp,
  parseStepTimingMetadata,
  readConversationWaitingForInput,
  readLatestStepTiming,
  STEP_STATUS_WAITING,
} from '../src/step-timing.mjs';
import { classifyAgentActivity } from '../src/agent-state.mjs';
import { renderNativeTitle } from '../src/title.mjs';

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

test('parseStepTimingMetadata extracts exact TTFT, streaming duration, completion timestamp, and output tokens', () => {
  // created_at = 1795686158.200s, first_token_at = +6.050s, finished_gen_at = +4.000s (total 10.050s)
  const usageMsg = Buffer.concat([pbVarint(2, 2400), pbVarint(3, 600), pbVarint(5, 280000), pbVarint(9, 420), pbVarint(10, 180)]);
  const meta = Buffer.concat([
    pbBytes(1, pbTimestamp(1795686158, 200_000_000)),
    pbBytes(6, pbTimestamp(1795686164, 250_000_000)),
    pbBytes(7, pbTimestamp(1795686168, 250_000_000)),
    pbBytes(8, pbTimestamp(1795686168, 250_000_000)),
    pbBytes(9, usageMsg),
  ]);

  const parsed = parseStepTimingMetadata(meta, 2574);
  assert.ok(parsed);
  assert.equal(parsed.idx, 2574);
  assert.equal(parsed.ttftMs, 6050);
  assert.equal(parsed.streamMs, 4000);
  assert.equal(parsed.totalMs, 10050);
  assert.equal(parsed.outputTokens, 600);
  assert.equal(parsed.visibleOutputTokens, 420);
  assert.equal(parsed.completedAtMs, 1795686168250);
});

test('parseStepTimingMetadata returns null safely on malformed or empty buffers', () => {
  assert.equal(parseStepTimingMetadata(null), null);
  assert.equal(parseStepTimingMetadata(Buffer.alloc(0)), null);
  assert.equal(parseStepTimingMetadata(Buffer.from([0xff, 0xff, 0xff])), null);
});

test('getDbVersionStamp short-circuits readLatestStepTiming when unchanged and writeFileAtomic leaves no temp files', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-dbstamp-'));
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    const convDir = join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbFile = join(convDir, `${id}.db`);
    writeFileAtomic(dbFile, 'stub-db');
    assert.equal(readFileSync(dbFile, 'utf8'), 'stub-db');
    assert.deepEqual(readdirSync(convDir), [`${id}.db`]);

    const stamp1 = getDbVersionStamp(dbFile);
    assert.ok(stamp1);

    // Matching prevDbStamp skips opening SQLite completely (even on non-SQLite stub file).
    const skipped = await readLatestStepTiming({ conversation_id: id }, { home: fakeHome, prevDbStamp: stamp1 });
    assert.deepEqual(skipped, { unchanged: true, dbStamp: stamp1 });

    // Writing a WAL changes the version stamp immediately.
    writeFileSync(`${dbFile}-wal`, 'wal-change');
    const stamp2 = getDbVersionStamp(dbFile);
    assert.notEqual(stamp2, stamp1);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('detects ask_question waiting state (steps.status=9) across step-timing, agent-state, and native title', async (t) => {
  // Pure classifier check works on all Node versions (including Node 20 without node:sqlite).
  const inputAct = classifyAgentActivity({ agent_state: 'working', waiting_for_input: true });
  assert.equal(inputAct.kind, 'input');
  assert.equal(inputAct.tabPrefix, '? ');
  assert.equal(inputAct.statusBadge, 'INPUT');
  assert.equal(inputAct.monitorLabel, 'input');
  assert.equal(inputAct.needsAttention, true);
  // Idle state never gets stuck on INPUT even if waiting_for_input flag were stale.
  assert.equal(classifyAgentActivity({ agent_state: 'idle', waiting_for_input: true }).kind, 'idle');

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('node:sqlite requires Node >= 22.13');
    return;
  }

  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-bar-waiting-'));
  try {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const convDir = join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbFile = join(convDir, `${id}.db`);
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);');
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 20, STEP_STATUS_WAITING, null);
    db.close();

    const timing = await readLatestStepTiming({ conversation_id: id }, { home: fakeHome });
    assert.equal(timing.waitingForInput, true);
    assert.equal(readConversationWaitingForInput({ conversation_id: id }, { home: fakeHome }), true);

    const titleWhileWaiting = renderNativeTitle(
      { conversation_id: id, agent_state: 'working', conversation_title: 'Multi-Account Design' },
      { home: fakeHome, baseDir: join(fakeHome, '.gemini', 'config', 'agy-bar'), touchMarker: false },
    );
    assert.ok(titleWhileWaiting.startsWith('? '), `expected "? " prefix, got "${titleWhileWaiting}"`);

    // Once user answers, step transitions to COMPLETED (3) -> immediately reverts to active working dot.
    const db2 = new DatabaseSync(dbFile);
    db2.prepare('UPDATE steps SET status = 3 WHERE idx = 1').run();
    db2.close();

    const timingAfter = await readLatestStepTiming({ conversation_id: id }, { home: fakeHome });
    assert.equal(timingAfter.waitingForInput, false);
    const titleAfter = renderNativeTitle(
      { conversation_id: id, agent_state: 'working', conversation_title: 'Multi-Account Design' },
      { home: fakeHome, baseDir: join(fakeHome, '.gemini', 'config', 'agy-bar'), touchMarker: false },
    );
    assert.ok(titleAfter.startsWith('● '), `expected "● " prefix, got "${titleAfter}"`);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStepTimingMetadata } from '../src/step-timing.mjs';

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

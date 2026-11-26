import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function decodePbFields(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let offset = 0;
  const fields = {};

  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < b.length; shift += 7n) {
      const byte = b[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return Number(value);
    }
    throw new Error('Incomplete protobuf varint');
  };

  while (offset < b.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      fields[field] = readVarint();
    } else if (wire === 1) {
      if (offset + 8 > b.length) throw new Error('Incomplete fixed64');
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > b.length) throw new Error('Incomplete fixed32');
      offset += 4;
    } else if (wire === 2) {
      const len = readVarint();
      if (len < 0 || offset + len > b.length) throw new Error('Incomplete length-delimited field');
      fields[field] = b.subarray(offset, offset + len);
      offset += len;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wire}`);
    }
  }
  return fields;
}

function decodeTimestampMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  try {
    const m = decodePbFields(buf);
    const seconds = typeof m[1] === 'number' && Number.isFinite(m[1]) && m[1] > 0 ? m[1] : null;
    const nanos = typeof m[2] === 'number' && Number.isFinite(m[2]) && m[2] >= 0 ? m[2] : 0;
    return seconds !== null ? Math.round(seconds * 1000 + nanos / 1e6) : null;
  } catch {
    return null;
  }
}

// Reads ONLY numeric timing & token-count metadata from a completed PlannerResponse (step_type=15).
// Never inspects prompt/response payloads.
export function parseStepTimingMetadata(metadata, idx = null) {
  if (!metadata) return null;
  try {
    const f = decodePbFields(metadata);
    const createdAtMs = decodeTimestampMs(f[1]);
    const firstTokenAtMs = decodeTimestampMs(f[6]);
    const finishedGenAtMs = decodeTimestampMs(f[7]);
    const completedAtMs = decodeTimestampMs(f[8]) ?? finishedGenAtMs;

    const ttftMs =
      createdAtMs !== null && firstTokenAtMs !== null && firstTokenAtMs >= createdAtMs && firstTokenAtMs - createdAtMs <= 600_000
        ? firstTokenAtMs - createdAtMs
        : null;

    const streamEnd = finishedGenAtMs ?? completedAtMs;
    const streamMs =
      firstTokenAtMs !== null && streamEnd !== null && streamEnd >= firstTokenAtMs && streamEnd - firstTokenAtMs <= 600_000
        ? streamEnd - firstTokenAtMs
        : null;

    const totalMs =
      createdAtMs !== null && completedAtMs !== null && completedAtMs >= createdAtMs && completedAtMs - createdAtMs <= 900_000
        ? completedAtMs - createdAtMs
        : null;

    let outputTokens = null;
    let visibleOutputTokens = null;
    if (Buffer.isBuffer(f[9])) {
      try {
        const usage = decodePbFields(f[9]);
        if (typeof usage[3] === 'number' && usage[3] > 0) outputTokens = usage[3];
        if (typeof usage[9] === 'number' && usage[9] > 0) visibleOutputTokens = usage[9];
      } catch {
        // Ignore optional usage sub-message errors.
      }
    }

    if (ttftMs === null && completedAtMs === null) return null;
    return {
      idx,
      createdAtMs,
      firstTokenAtMs,
      completedAtMs,
      ttftMs,
      streamMs,
      totalMs,
      outputTokens,
      visibleOutputTokens,
    };
  } catch {
    return null;
  }
}

export async function readLatestStepTiming(payload, { home = homedir() } = {}) {
  const id = payload?.conversation_id || payload?.session_id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;

  const dbPath = join(home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`);
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 ORDER BY idx DESC LIMIT 1')
      .get();
    return row ? parseStepTimingMetadata(row.metadata, row.idx) : null;
  } catch {
    // Gracefully fall back on Node < 22.13, locked DBs, or schema changes.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

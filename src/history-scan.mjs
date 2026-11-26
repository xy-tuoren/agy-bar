import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from './config.mjs';
import { parseStepTimingMetadata } from './step-timing.mjs';

const MODEL_ENUM_MAP = Object.freeze({
  1535: 'Gemini 4 Neon',
  1530: 'Gemini 4 Hydrogen',
  1427: 'Gemini 4 Carbon',
  1417: 'Gemini 4 Argon',
  1318: 'Gemini 3.8 Flash',
  1319: 'Gemini 3.8 Flash',
});

const CACHE_SCHEMA_VERSION = 1;

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
      throw new Error(`Unsupported wire type: ${wire}`);
    }
  }
  return fields;
}

export function resolveModelEnum(enumId) {
  if (typeof enumId !== 'number' || !Number.isFinite(enumId)) return 'Unknown';
  return MODEL_ENUM_MAP[enumId] || `Model #${enumId}`;
}

// Pure parser: extracts ONLY numeric timestamps and token counts from step_type=15 metadata.
// Never inspects prompt or reply content.
export function parseStepUsageMetadata(metadata, { session = 'unknown', source = 'cli' } = {}) {
  if (!metadata) return null;
  try {
    const f = decodePbFields(metadata);
    if (!Buffer.isBuffer(f[9])) return null;
    const u = decodePbFields(f[9]);

    const input = typeof u[2] === 'number' && u[2] >= 0 ? u[2] : 0;
    const output = typeof u[3] === 'number' && u[3] >= 0 ? u[3] : 0;
    const cacheRead = typeof u[5] === 'number' && u[5] >= 0 ? u[5] : 0;
    const visibleOutput = typeof u[9] === 'number' && u[9] >= 0 ? u[9] : 0;
    const thinking = typeof u[10] === 'number' && u[10] >= 0 ? u[10] : 0;
    if (input + output + cacheRead === 0) return null;

    const timing = parseStepTimingMetadata(metadata);
    const ts = timing?.completedAtMs ?? timing?.createdAtMs ?? null;
    if (!ts || ts <= 0) return null;

    let tokPerSec = null;
    if (timing?.streamMs >= 400) {
      const streamTokens = visibleOutput > 0 ? visibleOutput : output;
      const rate = streamTokens / (timing.streamMs / 1000);
      if (rate > 0 && rate < 600) tokPerSec = Math.round(rate * 10) / 10;
    }
    if (tokPerSec === null && output > 0 && timing?.totalMs >= 200) {
      const rate = output / (timing.totalMs / 1000);
      if (rate > 0 && rate < 600) tokPerSec = Math.round(rate * 10) / 10;
    }

    return {
      ts,
      session: String(session).slice(0, 16),
      source,
      model: resolveModelEnum(u[1]),
      effort: null,
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      thinking,
      ttftMs: timing?.ttftMs ?? null,
      durationMs: timing?.totalMs ?? null,
      tokPerSec,
    };
  } catch {
    return null;
  }
}

export function scanCachePath(baseDir = configDir(homedir())) {
  return join(baseDir, 'scan-cache.json');
}

function loadScanCache(cacheFile) {
  try {
    if (!existsSync(cacheFile)) return { version: CACHE_SCHEMA_VERSION, files: {} };
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (parsed?.version === CACHE_SCHEMA_VERSION && parsed.files && typeof parsed.files === 'object') {
      return parsed;
    }
  } catch {
    // Ignore corrupted cache and rebuild cleanly.
  }
  return { version: CACHE_SCHEMA_VERSION, files: {} };
}

function saveScanCache(cacheFile, cache) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
  } catch {
    // Ignore write failures silently.
  }
}

export function defaultConversationRoots(home = homedir()) {
  return [
    { source: 'cli', dir: join(home, '.gemini', 'antigravity-cli', 'conversations') },
    { source: 'desktop', dir: join(home, '.gemini', 'antigravity', 'conversations') },
  ];
}

export async function scanConversationHistory({
  home = homedir(),
  baseDir = configDir(home),
  roots = null,
  sourceFilter = 'all',
  useCache = true,
} = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { supported: false, entries: [], scannedDbs: 0, cachedDbs: 0 };
  }

  const targetRoots = (roots || defaultConversationRoots(home)).filter(
    (r) => (sourceFilter === 'all' || r.source === sourceFilter) && existsSync(r.dir),
  );

  const cacheFile = scanCachePath(baseDir);
  const cache = useCache ? loadScanCache(cacheFile) : { version: CACHE_SCHEMA_VERSION, files: {} };
  const nextFiles = {};
  const entries = [];
  let scannedDbs = 0;
  let cachedDbs = 0;
  let cacheDirty = false;

  for (const { source, dir } of targetRoots) {
    let filenames = [];
    try {
      filenames = readdirSync(dir).filter((f) => f.endsWith('.db'));
    } catch {
      continue;
    }

    for (const file of filenames) {
      const fullPath = join(dir, file);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      const cached = cache.files[fullPath];
      if (useCache && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && Array.isArray(cached.entries)) {
        nextFiles[fullPath] = cached;
        cachedDbs += 1;
        for (const item of cached.entries) entries.push(item);
        continue;
      }

      const session = file.replace(/\.db$/i, '');
      const dbEntries = [];
      let db;
      try {
        db = new DatabaseSync(fullPath, { readOnly: true });
        scannedDbs += 1;
        const rows = db.prepare('SELECT metadata FROM steps WHERE step_type = 15 AND status = 3').all();
        for (const row of rows) {
          const parsed = parseStepUsageMetadata(row.metadata, { session, source });
          if (parsed) dbEntries.push(parsed);
        }
      } catch {
        // Skip unreadable or locked DB files cleanly.
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore close errors.
        }
      }

      nextFiles[fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size, entries: dbEntries };
      cacheDirty = true;
      for (const item of dbEntries) entries.push(item);
    }
  }

  if (useCache && (cacheDirty || Object.keys(cache.files).length !== Object.keys(nextFiles).length)) {
    saveScanCache(cacheFile, { version: CACHE_SCHEMA_VERSION, files: nextFiles });
  }

  return { supported: true, entries, scannedDbs, cachedDbs };
}

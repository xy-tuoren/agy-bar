import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { estimateCost } from './pricing.mjs';
import { decodePbFields, parseStepTimingMetadata } from './step-timing.mjs';

const MODEL_ENUM_MAP = Object.freeze({
  1535: 'Gemini 4 Neon',
  1530: 'Gemini 4 Hydrogen',
  1427: 'Gemini 4 Carbon',
  1417: 'Gemini 4 Argon',
  1318: 'Gemini 3.8 Flash',
  1319: 'Gemini 3.8 Flash',
});

const CACHE_SCHEMA_VERSION = 1;

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

export function usageSummaryPath(baseDir = configDir(homedir())) {
  return join(baseDir, 'usage-summary.json');
}

function localDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeUsageSummary(entries, { now = Date.now() } = {}) {
  const nowDate = new Date(now);
  const todayKey = localDateKey(now);
  const todayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const monthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime();
  const recentCutoff = now - 48 * 60 * 60 * 1000;

  let todayTokens = 0;
  let weekTokens = 0;
  let monthTokens = 0;
  let totalTokens = 0;
  let todayCostUsd = 0;
  const sessionCosts = new Map();
  const recentSessions = new Set();

  for (const e of entries || []) {
    const tok = (Number(e.input) || 0) + (Number(e.output) || 0) + (Number(e.cacheRead) || 0) + (Number(e.cacheWrite) || 0);
    if (tok <= 0) continue;
    totalTokens += tok;
    const isToday = typeof e.ts === 'number' && localDateKey(e.ts) === todayKey;
    if (typeof e.ts === 'number') {
      if (isToday) todayTokens += tok;
      if (e.ts >= weekStart) weekTokens += tok;
      if (e.ts >= monthStart) monthTokens += tok;
    }

    const sid = e.session ? String(e.session).slice(0, 16) : null;
    if (sid && typeof e.ts === 'number' && e.ts >= recentCutoff) {
      recentSessions.add(sid);
    }

    const est = estimateCost(e);
    if (est.priced && est.costUsd > 0) {
      if (isToday) todayCostUsd += est.costUsd;
      if (sid) sessionCosts.set(sid, (sessionCosts.get(sid) || 0) + est.costUsd);
    }
  }

  const recentSessionCosts = {};
  for (const sid of recentSessions) {
    const cost = sessionCosts.get(sid);
    if (cost && cost > 0) {
      recentSessionCosts[sid] = Math.round(cost * 10_000) / 10_000;
    }
  }

  return {
    updatedAt: now,
    date: todayKey,
    todayTokens,
    weekTokens,
    monthTokens,
    totalTokens,
    todayCostUsd: Math.round(todayCostUsd * 10_000) / 10_000,
    recentSessionCosts,
  };
}

export function readUsageSummary({ baseDir = configDir(homedir()) } = {}) {
  const path = usageSummaryPath(baseDir);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (
      parsed &&
      typeof parsed.totalTokens === 'number' &&
      typeof parsed.todayTokens === 'number' &&
      typeof parsed.weekTokens === 'number' &&
      typeof parsed.monthTokens === 'number' &&
      typeof parsed.todayCostUsd === 'number'
    ) {
      return parsed;
    }
  } catch {
    // Ignore corrupt or legacy summary snapshot so it refreshes cleanly.
  }
  return null;
}

export function saveUsageSummary(summary, { baseDir = configDir(homedir()) } = {}) {
  const path = usageSummaryPath(baseDir);
  try {
    writeFileAtomic(path, JSON.stringify(summary) + '\n');
  } catch {
    // Ignore write failures silently.
  }
  return summary;
}

function attachSessionCost(summary, sessionId) {
  if (!summary) return null;
  const sid = sessionId ? String(sessionId).slice(0, 16) : null;
  const sessionCostUsd =
    sid && summary.recentSessionCosts && typeof summary.recentSessionCosts[sid] === 'number'
      ? summary.recentSessionCosts[sid]
      : null;
  return sessionCostUsd !== null ? { ...summary, sessionCostUsd } : summary;
}

export async function getOrRefreshUsageSummary({
  home = homedir(),
  baseDir = configDir(home),
  now = Date.now(),
  maxAgeMs = 5 * 60 * 1000,
  sessionId = null,
  deltaTokens = 0,
  deltaCostUsd = 0,
  allowScan = true,
  fallbackEntries = null,
} = {}) {
  const todayKey = localDateKey(now);
  const existing = readUsageSummary({ baseDir });
  const shortSid = sessionId ? String(sessionId).slice(0, 16) : null;

  if (existing && existing.date === todayKey && typeof existing.updatedAt === 'number' && now - existing.updatedAt < maxAgeMs) {
    if (deltaTokens > 0 || deltaCostUsd > 0) {
      const nextRecent = { ...(existing.recentSessionCosts || {}) };
      if (shortSid && deltaCostUsd > 0) {
        nextRecent[shortSid] = Math.round(((nextRecent[shortSid] || 0) + deltaCostUsd) * 10_000) / 10_000;
      }
      const bumped = {
        ...existing,
        todayTokens: existing.todayTokens + deltaTokens,
        weekTokens: existing.weekTokens + deltaTokens,
        monthTokens: existing.monthTokens + deltaTokens,
        totalTokens: existing.totalTokens + deltaTokens,
        todayCostUsd: Math.round((existing.todayCostUsd + deltaCostUsd) * 10_000) / 10_000,
        recentSessionCosts: nextRecent,
      };
      return attachSessionCost(saveUsageSummary(bumped, { baseDir }), sessionId);
    }
    return attachSessionCost(existing, sessionId);
  }

  if (allowScan) {
    const scan = await scanConversationHistory({ home, baseDir, sourceFilter: 'all', useCache: true });
    if (scan.supported && scan.entries.length > 0) {
      const summary = computeUsageSummary(scan.entries, { now });
      return attachSessionCost(saveUsageSummary(summary, { baseDir }), sessionId);
    }
  }

  if (Array.isArray(fallbackEntries) && fallbackEntries.length > 0) {
    const summary = computeUsageSummary(fallbackEntries, { now });
    return attachSessionCost(saveUsageSummary(summary, { baseDir }), sessionId);
  }

  if (existing) {
    const rolled =
      existing.date === todayKey
        ? { ...existing, recentSessionCosts: { ...(existing.recentSessionCosts || {}) } }
        : { ...existing, date: todayKey, todayTokens: 0, todayCostUsd: 0, recentSessionCosts: { ...(existing.recentSessionCosts || {}) }, updatedAt: now };
    if (deltaTokens > 0 || deltaCostUsd > 0) {
      rolled.todayTokens += deltaTokens;
      rolled.weekTokens += deltaTokens;
      rolled.monthTokens += deltaTokens;
      rolled.totalTokens += deltaTokens;
      rolled.todayCostUsd = Math.round((rolled.todayCostUsd + deltaCostUsd) * 10_000) / 10_000;
      if (shortSid && deltaCostUsd > 0) {
        rolled.recentSessionCosts[shortSid] = Math.round(((rolled.recentSessionCosts[shortSid] || 0) + deltaCostUsd) * 10_000) / 10_000;
      }
    }
    return attachSessionCost(saveUsageSummary(rolled, { baseDir }), sessionId);
  }

  return null;
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
    writeFileAtomic(cacheFile, JSON.stringify(cache));
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

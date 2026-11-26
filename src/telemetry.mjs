import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sanitizeText } from './ansi.mjs';
import { configDir } from './config.mjs';

const BUSY_STATES = new Set(['working', 'tool_use', 'thinking']);

function nonNeg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function sessionsDir(baseDir = configDir(homedir())) {
  return join(baseDir, 'sessions');
}

export function ledgerPath(baseDir = configDir(homedir())) {
  return join(baseDir, 'ledger.jsonl');
}

export function deriveSessionId(payload) {
  const raw = payload?.conversation_id || payload?.session_id;
  if (typeof raw === 'string' && raw.trim()) {
    const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (cleaned) return cleaned;
  }
  const cwd = payload?.workspace?.current_dir || payload?.cwd || '';
  const model = payload?.model?.id || payload?.model?.display_name || '';
  if (cwd || model) {
    return `local-${createHash('sha1').update(`${cwd}|${model}`).digest('hex').slice(0, 12)}`;
  }
  return 'default';
}

function readSessionFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function normalizeModelName(model) {
  const raw = sanitizeText(model?.display_name || model?.id || '');
  const effort = sanitizeText(model?.effort || '');
  if (!raw) return 'Unknown';
  return effort ? raw.replace(/\s*\((?:low|medium|high|xhigh|max)\)$/i, '').trim() : raw;
}

function pickQuotaSnapshot(quota) {
  if (!quota || typeof quota !== 'object') return null;
  const out = {};
  for (const [id, bucket] of Object.entries(quota)) {
    if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) continue;
    const remaining = nonNeg(bucket.remaining_fraction);
    if (remaining !== null) {
      out[id] = {
        remaining,
        reset_time: typeof bucket.reset_time === 'string' ? bucket.reset_time : null,
        reset_in_seconds: nonNeg(bucket.reset_in_seconds),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function recordTelemetry(
  payload = {},
  {
    now = Date.now(),
    git = null,
    baseDir = configDir(homedir()),
    cacheTtlSec = 300,
    enableLedger = true,
  } = {},
) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = deriveSessionId(p);
  const sDir = sessionsDir(baseDir);
  const sFile = join(sDir, `${sessionId}.json`);
  const prev = readSessionFile(sFile);

  const ctx = p.context_window || {};
  const usage = ctx.current_usage && typeof ctx.current_usage === 'object' ? ctx.current_usage : null;
  const totalIn = nonNeg(ctx.total_input_tokens);
  const totalOut = nonNeg(ctx.total_output_tokens);
  const usedPct = nonNeg(ctx.used_percentage);
  const windowSize = nonNeg(ctx.context_window_size);
  const curIn = nonNeg(usage?.input_tokens) ?? 0;
  const curOut = nonNeg(usage?.output_tokens) ?? 0;
  const curCacheRead = nonNeg(usage?.cache_read_input_tokens) ?? 0;
  const curCacheWrite = nonNeg(usage?.cache_creation_input_tokens) ?? 0;

  const isBusy = BUSY_STATES.has(p.agent_state);
  const wasBusy = Boolean(prev?.isBusy);

  let turnStartedAt = prev?.turnStartedAt ?? null;
  if (isBusy && (!wasBusy || turnStartedAt === null)) {
    turnStartedAt = now;
  }

  // Track output & usage changes for turn speed + cache TTL + ledger.
  const prevTotalOut = nonNeg(prev?.totalOut);
  const prevTotalIn = nonNeg(prev?.totalIn);
  const prevUsedPct = nonNeg(prev?.usedPct);

  const outDelta =
    prev !== null && prevTotalOut !== null && totalOut !== null && totalOut > prevTotalOut
      ? totalOut - prevTotalOut
      : prev === null && totalOut !== null && totalOut > 0 && curOut > 0 && totalOut <= curOut * 1.1
        ? totalOut
        : 0;

  const inDelta =
    prev !== null && prevTotalIn !== null && totalIn !== null && totalIn > prevTotalIn
      ? totalIn - prevTotalIn
      : 0;

  const usageSignature = usage ? `${curIn}:${curOut}:${curCacheRead}:${curCacheWrite}` : null;
  const usageChanged = Boolean(usageSignature && prev && prev.usageSignature !== usageSignature);

  let lastActivityAt = nonNeg(prev?.lastActivityAt);
  let lastSpeedTokPerSec = nonNeg(prev?.lastSpeedTokPerSec);
  let lastTurnDurationMs = nonNeg(prev?.lastTurnDurationMs);
  let lastContextDelta = typeof prev?.lastContextDelta === 'number' && Number.isFinite(prev.lastContextDelta) ? prev.lastContextDelta : null;

  if (outDelta > 0 || inDelta > 0 || usageChanged) {
    lastActivityAt = now;
  } else if (lastActivityAt === null && usage !== null && (curIn > 0 || curCacheRead > 0)) {
    lastActivityAt = now;
  }

  if (outDelta > 0) {
    let durationMs = null;
    if (turnStartedAt !== null && now > turnStartedAt && now - turnStartedAt <= 600_000) {
      durationMs = now - turnStartedAt;
    } else if (prev?.updatedAt && now > prev.updatedAt && now - prev.updatedAt <= 120_000) {
      durationMs = now - prev.updatedAt;
    }

    if (durationMs !== null && durationMs >= 100) {
      const rate = outDelta / (durationMs / 1000);
      if (rate > 0 && rate < 5000) {
        lastSpeedTokPerSec = Math.round(rate * 10) / 10;
        lastTurnDurationMs = durationMs;
      }
    }

    if (windowSize && usedPct !== null && prevUsedPct !== null) {
      const approxDelta = Math.round(((usedPct - prevUsedPct) / 100) * windowSize);
      if (approxDelta > 0) lastContextDelta = approxDelta;
    } else if (inDelta + outDelta > 0) {
      lastContextDelta = inDelta + outDelta;
    }

    if (enableLedger) {
      try {
        mkdirSync(baseDir, { recursive: true });
        const modelName = normalizeModelName(p.model);
        const entry = {
          ts: now,
          session: sessionId.slice(0, 16),
          model: modelName,
          effort: sanitizeText(p.model?.effort || '') || null,
          input: inDelta > 0 ? inDelta : curIn,
          output: outDelta,
          cacheRead: curCacheRead,
          cacheWrite: curCacheWrite,
          durationMs: lastTurnDurationMs,
          tokPerSec: lastSpeedTokPerSec,
          quota5h: nonNeg(p.quota?.['gemini-5h']?.remaining_fraction ?? p.quota?.['3p-5h']?.remaining_fraction),
          quotaWeekly: nonNeg(
            p.quota?.['gemini-weekly']?.remaining_fraction ??
              p.quota?.['3p-weekly']?.remaining_fraction ??
              p.quota?.['gemini-argon-wtu-weekly']?.remaining_fraction,
          ),
        };
        appendFileSync(ledgerPath(baseDir), JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // Never fail statusline rendering due to disk issues.
      }
    }
  }

  if (!isBusy) {
    turnStartedAt = null;
  }

  const cwd = p.workspace?.current_dir || p.cwd || prev?.cwd || null;
  const cacheTtlMs = Math.max(30, cacheTtlSec) * 1000;
  const cacheRemainingSec =
    lastActivityAt !== null ? Math.max(0, Math.round((cacheTtlMs - (now - lastActivityAt)) / 1000)) : null;

  const nextState = {
    sessionId,
    updatedAt: now,
    cwd,
    workspaceName: cwd ? basename(cwd) : prev?.workspaceName || null,
    branch: git?.branch || prev?.branch || null,
    dirty: typeof git?.dirty === 'boolean' ? git.dirty : Boolean(prev?.dirty),
    agentState: sanitizeText(p.agent_state || '') || 'idle',
    isBusy,
    model: normalizeModelName(p.model),
    effort: sanitizeText(p.model?.effort || '') || null,
    usedPct,
    windowSize,
    totalIn,
    totalOut,
    cacheHitPct: curIn + curCacheRead > 0 ? Math.round((curCacheRead / (curIn + curCacheRead)) * 1000) / 10 : prev?.cacheHitPct ?? null,
    usageSignature,
    turnStartedAt,
    lastActivityAt,
    lastSpeedTokPerSec,
    lastTurnDurationMs,
    lastContextDelta,
    quota: pickQuotaSnapshot(p.quota) || prev?.quota || null,
  };

  try {
    mkdirSync(sDir, { recursive: true });
    writeFileSync(sFile, JSON.stringify(nextState) + '\n', 'utf8');
  } catch {
    // Ignore write failures silently.
  }

  return {
    sessionId,
    cacheRemainingSec,
    cacheExpired: cacheRemainingSec === 0 && lastActivityAt !== null,
    speedTokPerSec: lastSpeedTokPerSec,
    turnDurationMs: lastTurnDurationMs,
    contextDelta: lastContextDelta,
    lastActivityAt,
  };
}

export function listSessions({ baseDir = configDir(homedir()), now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000, prune = false } = {}) {
  const sDir = sessionsDir(baseDir);
  if (!existsSync(sDir)) return [];
  const results = [];
  for (const name of readdirSync(sDir)) {
    if (!name.endsWith('.json')) continue;
    const full = join(sDir, name);
    const data = readSessionFile(full);
    if (!data || !nonNeg(data.updatedAt)) continue;
    const ageMs = Math.max(0, now - data.updatedAt);
    if (ageMs > maxAgeMs) {
      if (prune) {
        try {
          rmSync(full, { force: true });
        } catch {
          // Ignore prune errors.
        }
      }
      continue;
    }
    results.push({ ...data, ageMs });
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

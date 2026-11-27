import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { classifyAgentActivity } from './agent-state.mjs';
import { sanitizeText } from './ansi.mjs';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { estimateCost } from './pricing.mjs';

function nonNeg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function sessionsDir(baseDir = configDir(homedir())) {
  return join(baseDir, 'sessions');
}

export function ledgerPath(baseDir = configDir(homedir())) {
  return join(baseDir, 'ledger.jsonl');
}

export function captureSentinelPath(baseDir = configDir(homedir())) {
  return join(baseDir, '.capture-once');
}

export function capturedPayloadPath(baseDir = configDir(homedir())) {
  return join(baseDir, 'last-payload.redacted.json');
}

export function redactPayload(payload, home = homedir()) {
  const seen = new WeakSet();
  const redactString = (value, keyName = '') => {
    const lowerKey = keyName.toLowerCase();
    if (lowerKey.includes('email')) return '***@***';
    if (lowerKey.includes('token') && !lowerKey.includes('tokens')) return '[REDACTED]';
    if (lowerKey === 'conversation_id' || lowerKey === 'session_id') {
      return value.length > 8 ? `${value.slice(0, 8)}…` : value;
    }
    if (lowerKey === 'conversation_title') {
      return value ? `[TITLE len=${value.length}]` : value;
    }
    let out = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '***@***');
    if (home) {
      const variants = [...new Set([home, home.replace(/\\/g, '/')])].filter(Boolean);
      const isWinHome = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(home);
      for (const variant of variants) {
        if (isWinHome) {
          const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          out = out.replace(new RegExp(escaped, 'gi'), '~');
        } else if (out.includes(variant)) {
          out = out.split(variant).join('~');
        }
      }
    }
    return out;
  };

  const walk = (node, keyName = '') => {
    if (typeof node === 'string') return redactString(node, keyName);
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return '[Circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map((item) => walk(item, keyName));
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walk(v, k);
    }
    return out;
  };

  return walk(payload);
}

export function armPayloadCapture({ baseDir = configDir(homedir()) } = {}) {
  mkdirSync(baseDir, { recursive: true });
  const sentinel = captureSentinelPath(baseDir);
  writeFileSync(sentinel, `${Date.now()}\n`, 'utf8');
  return { sentinel, target: capturedPayloadPath(baseDir) };
}

export function maybeCaptureRedactedPayload(payload, { baseDir = configDir(homedir()), home = homedir(), now = Date.now() } = {}) {
  const sentinel = captureSentinelPath(baseDir);
  if (!existsSync(sentinel)) return false;
  try {
    const redacted = {
      capturedAt: new Date(now).toISOString(),
      payload: redactPayload(payload, home),
    };
    writeFileAtomic(capturedPayloadPath(baseDir), JSON.stringify(redacted, null, 2) + '\n');
    rmSync(sentinel, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readCapturedPayload({ baseDir = configDir(homedir()) } = {}) {
  const target = capturedPayloadPath(baseDir);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
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

export function peekSessionState(payload = {}, { baseDir = configDir(homedir()) } = {}) {
  const sessionId = deriveSessionId(payload);
  return readSessionFile(join(sessionsDir(baseDir), `${sessionId}.json`));
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

export function resolveSessionTitles(payload = {}, prev = null) {
  const conversationTitle = sanitizeText(payload?.conversation_title || '') || prev?.conversationTitle || null;
  // If user explicitly renamed the conversation via /rename (conversation_title changed),
  // clear any older custom tab override automatically.
  let customTitle = prev?.customTitle || null;
  let customTitleBase = prev?.customTitleBase ?? null;
  if (customTitle && conversationTitle && customTitleBase && conversationTitle !== customTitleBase) {
    customTitle = null;
    customTitleBase = null;
  }
  return { conversationTitle, customTitle, customTitleBase };
}

export function recordTelemetry(
  payload = {},
  {
    now = Date.now(),
    git = null,
    stepTiming = null,
    prevSession = undefined,
    tabSync = null,
    baseDir = configDir(homedir()),
    cacheTtlSec = 300,
    enableLedger = true,
  } = {},
) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = deriveSessionId(p);
  const sDir = sessionsDir(baseDir);
  const sFile = join(sDir, `${sessionId}.json`);
  const prev = prevSession !== undefined ? prevSession : readSessionFile(sFile);

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

  const activity = classifyAgentActivity(p);
  const isMainBusy = activity.isMainBusy;
  const wasMainBusy = Boolean(prev?.isMainBusy ?? (prev?.activityKind ? prev.activityKind === 'working' : prev?.isBusy));

  let turnStartedAt = prev?.turnStartedAt ?? null;
  let turnFirstTokenAt = prev?.turnFirstTokenAt ?? null;
  if (isMainBusy && (!wasMainBusy || turnStartedAt === null)) {
    turnStartedAt = now;
    turnFirstTokenAt = null;
  }

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

  const startedAt = nonNeg(prev?.startedAt) ?? now;
  let sessionTurns = nonNeg(prev?.sessionTurns) ?? 0;
  let sessionCostUsd = nonNeg(prev?.sessionCostUsd) ?? 0;
  let sessionCacheSavedUsd = nonNeg(prev?.sessionCacheSavedUsd) ?? 0;

  let lastActivityAt = nonNeg(prev?.lastActivityAt);
  let lastTtftMs = nonNeg(prev?.lastTtftMs);
  let lastSpeedTokPerSec = nonNeg(prev?.lastSpeedTokPerSec);
  let lastTurnDurationMs = nonNeg(prev?.lastTurnDurationMs);
  let lastContextDelta = typeof prev?.lastContextDelta === 'number' && Number.isFinite(prev.lastContextDelta) ? prev.lastContextDelta : null;

  let hasDbCompletedAt = false;
  // Prefer exact step-level timestamps from local AGY read-only step metadata when available.
  if (stepTiming && typeof stepTiming === 'object') {
    if (stepTiming.unchanged === true && lastActivityAt !== null) {
      hasDbCompletedAt = true;
    } else {
      const dbTtft = nonNeg(stepTiming.ttftMs);
      if (dbTtft !== null && dbTtft <= 600_000) {
        lastTtftMs = dbTtft;
      }
      const dbCompleted = nonNeg(stepTiming.completedAtMs);
      if (dbCompleted !== null) {
        lastActivityAt = dbCompleted;
        hasDbCompletedAt = true;
      }
      const dbStreamMs = nonNeg(stepTiming.streamMs);
      const dbTotalMs = nonNeg(stepTiming.totalMs);
      const dbOut = nonNeg(stepTiming.outputTokens);
      const dbVisibleOut = nonNeg(stepTiming.visibleOutputTokens);
      let computedRate = null;
      if (dbStreamMs !== null && dbStreamMs >= 400) {
        const streamTokens = dbVisibleOut !== null && dbVisibleOut > 0 ? dbVisibleOut : dbOut;
        if (streamTokens !== null && streamTokens > 0) {
          const candidate = streamTokens / (dbStreamMs / 1000);
          if (candidate > 0 && candidate < 600) computedRate = candidate;
        }
      }
      if (computedRate === null && dbOut !== null && dbOut > 0 && dbTotalMs !== null && dbTotalMs >= 200) {
        const candidate = dbOut / (dbTotalMs / 1000);
        if (candidate > 0 && candidate < 600) computedRate = candidate;
      }
      if (computedRate !== null) {
        lastSpeedTokPerSec = Math.round(computedRate * 10) / 10;
        lastTurnDurationMs = dbTotalMs ?? dbStreamMs;
      }
    }
  }

  if (!hasDbCompletedAt) {
    if (outDelta > 0 || inDelta > 0 || usageChanged) {
      lastActivityAt = now;
    } else if (lastActivityAt === null && usage !== null && (curIn > 0 || curCacheRead > 0)) {
      lastActivityAt = now;
    }
  }

  const modelName = normalizeModelName(p.model);
  let turnTokensDelta = 0;
  let turnCostDeltaUsd = 0;

  if (outDelta > 0) {
    sessionTurns += 1;

    // Fallback stdin-based TTFT when DB timing is unavailable.
    if (turnStartedAt !== null && turnFirstTokenAt === null && now >= turnStartedAt) {
      turnFirstTokenAt = now;
      if (stepTiming?.ttftMs == null && now - turnStartedAt <= 600_000) {
        lastTtftMs = now - turnStartedAt;
      }
    }

    // Fallback stdin-based speed when DB timing did not produce a rate.
    const usedDbRate = Boolean(
      stepTiming &&
        ((stepTiming.streamMs >= 400 && (stepTiming.visibleOutputTokens > 0 || stepTiming.outputTokens > 0)) ||
          (stepTiming.outputTokens > 0 && stepTiming.totalMs >= 200)),
    );
    if (!usedDbRate) {
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
    }

    if (windowSize && usedPct !== null && prevUsedPct !== null) {
      const approxDelta = Math.round(((usedPct - prevUsedPct) / 100) * windowSize);
      if (approxDelta > 0) lastContextDelta = approxDelta;
    } else if (inDelta + outDelta > 0) {
      lastContextDelta = inDelta + outDelta;
    }

    const billedInput = inDelta > 0 ? inDelta : curIn;
    turnTokensDelta = billedInput + outDelta + curCacheRead + curCacheWrite;
    const est = estimateCost({
      model: modelName,
      input: billedInput,
      output: outDelta,
      cacheRead: curCacheRead,
      cacheWrite: curCacheWrite,
    });
    if (est.priced) {
      turnCostDeltaUsd = Math.round(est.costUsd * 1_000_000) / 1_000_000;
      sessionCostUsd = Math.round((sessionCostUsd + est.costUsd) * 1_000_000) / 1_000_000;
      sessionCacheSavedUsd = Math.round((sessionCacheSavedUsd + est.cacheSavedUsd) * 1_000_000) / 1_000_000;
    }

    if (enableLedger) {
      try {
        mkdirSync(baseDir, { recursive: true });
        const entry = {
          ts: now,
          session: sessionId.slice(0, 16),
          model: modelName,
          effort: sanitizeText(p.model?.effort || '') || null,
          input: billedInput,
          output: outDelta,
          cacheRead: curCacheRead,
          cacheWrite: curCacheWrite,
          ttftMs: lastTtftMs,
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

  if (!isMainBusy) {
    turnStartedAt = null;
    turnFirstTokenAt = null;
  }

  const turnElapsedSec =
    isMainBusy && turnStartedAt !== null && now >= turnStartedAt ? Math.floor((now - turnStartedAt) / 1000) : null;

  const cwd = p.workspace?.current_dir || p.cwd || prev?.cwd || null;
  const cacheTtlMs = Math.max(30, cacheTtlSec) * 1000;
  const cacheRemainingSec =
    lastActivityAt !== null ? Math.max(0, Math.round((cacheTtlMs - (now - lastActivityAt)) / 1000)) : null;

  const { conversationTitle, customTitle, customTitleBase } = resolveSessionTitles(p, prev);
  const tabWritten = Boolean(tabSync?.written && tabSync.title);
  const nextTabTitle = tabWritten ? tabSync.title : prev?.lastTabTitle || null;
  const nextTabHostPid = tabWritten
    ? (tabSync.hostPid ?? prev?.lastTabHostPid ?? null)
    : (prev?.lastTabHostPid ?? null);
  const nextTabTty = tabWritten
    ? (tabSync.tty && tabSync.tty !== 'custom' ? tabSync.tty : prev?.lastTabTty ?? null)
    : (prev?.lastTabTty ?? null);
  const nextTabUpdatedAt = tabWritten ? now : prev?.lastTabUpdatedAt ?? null;
  const nextTabError = tabWritten
    ? null
    : tabSync?.changed && !tabSync.written
      ? tabSync.error || 'write_failed'
      : prev?.lastTabError ?? null;

  const nextState = {
    sessionId,
    startedAt,
    updatedAt: now,
    cwd,
    workspaceName: cwd ? basename(cwd) : prev?.workspaceName || null,
    branch: git?.branch || prev?.branch || null,
    dirty: typeof git?.dirty === 'boolean' ? git.dirty : Boolean(prev?.dirty),
    gitAdded: typeof git?.added === 'number' ? git.added : prev?.gitAdded ?? null,
    gitRemoved: typeof git?.removed === 'number' ? git.removed : prev?.gitRemoved ?? null,
    gitCheckedAt: git?.dirtyChecked ? now : prev?.gitCheckedAt ?? null,
    dbStamp: stepTiming?.dbStamp ?? prev?.dbStamp ?? null,
    agentState: sanitizeText(p.agent_state || '') || 'idle',
    activityKind: activity.kind,
    needsAttention: activity.needsAttention,
    runningSubagents: activity.runningSubagents,
    runningTasks: activity.runningTasks,
    toolConfirmationPending: activity.confirmPending,
    isMainBusy,
    isBusy: activity.isActive,
    conversationTitle,
    customTitle,
    customTitleBase,
    lastTabTitle: nextTabTitle,
    lastTabHostPid: nextTabHostPid,
    lastTabTty: nextTabTty,
    lastTabUpdatedAt: nextTabUpdatedAt,
    lastTabError: nextTabError,
    model: modelName,
    effort: sanitizeText(p.model?.effort || '') || null,
    usedPct,
    windowSize,
    totalIn,
    totalOut,
    cacheHitPct: curIn + curCacheRead > 0 ? Math.round((curCacheRead / (curIn + curCacheRead)) * 1000) / 10 : prev?.cacheHitPct ?? null,
    usageSignature,
    turnStartedAt,
    turnFirstTokenAt,
    lastActivityAt,
    lastTtftMs,
    lastSpeedTokPerSec,
    lastTurnDurationMs,
    lastContextDelta,
    sessionTurns,
    sessionCostUsd,
    sessionCacheSavedUsd,
    quota: pickQuotaSnapshot(p.quota) || prev?.quota || null,
  };

  try {
    writeFileAtomic(sFile, JSON.stringify(nextState) + '\n');
  } catch {
    // Ignore write failures silently.
  }

  return {
    sessionId,
    cacheRemainingSec,
    cacheExpired: cacheRemainingSec === 0 && lastActivityAt !== null,
    ttftMs: lastTtftMs,
    speedTokPerSec: lastSpeedTokPerSec,
    turnDurationMs: lastTurnDurationMs,
    turnElapsedSec,
    contextDelta: lastContextDelta,
    sessionTurns,
    sessionCostUsd,
    sessionCacheSavedUsd,
    sessionDurationSec: Math.max(0, Math.round((now - startedAt) / 1000)),
    turnTokensDelta,
    turnCostDeltaUsd,
    lastActivityAt,
    conversationTitle,
    customTitle,
    prevTabTitle: nextTabTitle,
    prevTabHostPid: nextTabHostPid,
    prevTabTty: nextTabTty,
  };
}

export function updateSessionTabTitle(
  sessionId,
  tabTitle,
  { hostPid = null, tty = null, now = Date.now(), baseDir = configDir(homedir()) } = {},
) {
  if (!sessionId) return false;
  const sFile = join(sessionsDir(baseDir), `${sessionId}.json`);
  const prev = readSessionFile(sFile);
  if (!prev) return false;
  try {
    writeFileAtomic(
      sFile,
      JSON.stringify({
        ...prev,
        lastTabTitle: tabTitle,
        lastTabUpdatedAt: now,
        lastTabError: null,
        ...(hostPid !== null ? { lastTabHostPid: hostPid } : {}),
        ...(tty && tty !== 'custom' ? { lastTabTty: tty } : {}),
      }) + '\n',
    );
    return true;
  } catch {
    return false;
  }
}

function readNativeTitlePid(sessionId, baseDir) {
  const markerPath = join(sessionsDir(baseDir), `${sessionId}.title`);
  if (!existsSync(markerPath)) return null;
  try {
    const [, rawPid] = readFileSync(markerPath, 'utf8').trim().split(':');
    const pid = Number(rawPid);
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

export function findSessionForHost(sessions, hostPid, { baseDir = configDir(homedir()) } = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (typeof hostPid === 'number' && hostPid > 1) {
    const byTabPid = sessions.find((s) => s.lastTabHostPid === hostPid);
    if (byTabPid) return byTabPid;
    const byNativeMarker = sessions.find((s) => readNativeTitlePid(s.sessionId, baseDir) === hostPid);
    if (byNativeMarker) return byNativeMarker;
  }
  return sessions[0];
}

export function setSessionCustomTitle(
  title,
  { sessionId = null, hostPid = null, baseDir = configDir(homedir()), now = Date.now(), clear = false } = {},
) {
  const sDir = sessionsDir(baseDir);
  let targetId = sessionId ? String(sessionId).trim().replace(/[^a-zA-Z0-9_-]/g, '') : null;

  if (!targetId) {
    const recent = listSessions({ baseDir, now });
    targetId = findSessionForHost(recent, hostPid, { baseDir })?.sessionId || 'default';
  }

  const sFile = join(sDir, `${targetId}.json`);
  const prev = readSessionFile(sFile) || { sessionId: targetId, startedAt: now, updatedAt: now };
  const cleaned = clear ? null : sanitizeText(title || '');
  const next = {
    ...prev,
    sessionId: targetId,
    updatedAt: now,
    customTitle: cleaned || null,
    customTitleBase: cleaned ? prev.conversationTitle || null : null,
    lastTabTitle: null,
  };

  writeFileAtomic(sFile, JSON.stringify(next) + '\n');
  return next;
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
          rmSync(full.replace(/\.json$/, '.title'), { force: true });
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

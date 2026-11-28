import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';

// Go / protobuf zero timestamp ("1970-01-01T00:00:00Z") indicates an unused window, not an expired one.
export const EPOCH_SENTINEL_MS = 86_400_000;
export const RESET_TOLERANCE_MS = 5_000;
export const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000;
export const MAX_ACCOUNT_QUOTA_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const FRACTION_EPSILON = 1e-6;

const WEEKLY_SIBLING_BUCKET = Object.freeze({
  'gemini-5h': 'gemini-weekly',
  '3p-5h': '3p-weekly',
});

function nonNeg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readFraction(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const f = nonNeg(bucket.remaining_fraction ?? bucket.remaining);
  return f !== null ? Math.min(1, f) : null;
}

export function quotaCachePath(baseDir = configDir(homedir())) {
  return join(baseDir, 'quota-cache.json');
}

export function parseRealResetTs(bucket) {
  if (!bucket || typeof bucket !== 'object' || typeof bucket.reset_time !== 'string') return null;
  const ts = Date.parse(bucket.reset_time);
  return Number.isFinite(ts) && ts > EPOCH_SENTINEL_MS ? ts : null;
}

export function isEpochSentinelReset(bucket) {
  if (!bucket || typeof bucket !== 'object' || typeof bucket.reset_time !== 'string') return false;
  const ts = Date.parse(bucket.reset_time);
  return Number.isFinite(ts) && ts <= EPOCH_SENTINEL_MS;
}

export function isBucketResetDue(bucket, now = Date.now()) {
  if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) return false;
  if (isEpochSentinelReset(bucket)) return false;
  const resetTs = parseRealResetTs(bucket);
  if (resetTs !== null) return resetTs <= now;
  const resetSec = nonNeg(bucket.reset_in_seconds);
  return resetSec !== null && resetSec <= 0;
}

export function isWeeklyBucketBlocking(bucketId, quotaMap, now = Date.now()) {
  const weeklyId = WEEKLY_SIBLING_BUCKET[bucketId];
  if (!weeklyId || !quotaMap || typeof quotaMap !== 'object') return false;
  const weekly = quotaMap[weeklyId];
  if (!weekly || typeof weekly !== 'object' || weekly.disabled === true) return false;
  const weeklyFrac = readFraction(weekly);
  if (weeklyFrac === null || weeklyFrac > 0.005) return false;
  return !isBucketResetDue(weekly, now);
}

export function hashAccountIdentifier(raw) {
  const cleaned = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!cleaned) return null;
  return createHash('sha1').update(cleaned).digest('hex').slice(0, 12);
}

export function extractAccountKey(payload, { fallbackAccountKey = null } = {}) {
  const raw =
    payload?.email ||
    payload?.account?.email ||
    payload?.user_email ||
    payload?.account?.id ||
    payload?.account_id ||
    payload?.user_id ||
    '';
  const hashed = hashAccountIdentifier(raw);
  if (hashed) return hashed;
  if (typeof fallbackAccountKey === 'string' && fallbackAccountKey.trim()) {
    return fallbackAccountKey.trim();
  }
  return 'default';
}

export function normalizeQuotaBucket(raw, observedAt = Date.now()) {
  if (!raw || typeof raw !== 'object' || raw.disabled === true) return null;
  const remaining_fraction = readFraction(raw);
  const remaining_amount = nonNeg(raw.remaining_amount);
  if (remaining_fraction === null && remaining_amount === null) return null;

  const reset_time = typeof raw.reset_time === 'string' && raw.reset_time.trim() ? raw.reset_time.trim() : null;
  const reset_ts = parseRealResetTs({ reset_time });
  const reset_in_seconds = nonNeg(raw.reset_in_seconds);
  const obs = nonNeg(raw.observedAt) ?? observedAt;

  return {
    remaining_fraction,
    remaining_amount,
    reset_time,
    reset_ts,
    reset_in_seconds,
    observedAt: obs,
  };
}

export function pickFresherBucket(incoming, cached, now = Date.now()) {
  if (!incoming && !cached) return { bucket: null, source: 'none', changedCache: false };
  if (!incoming) return { bucket: cached, source: 'cached', changedCache: false };
  if (!cached) return { bucket: incoming, source: 'incoming', changedCache: true };

  if (now - cached.observedAt > MAX_CACHE_AGE_MS) {
    return { bucket: incoming, source: 'incoming', changedCache: true };
  }

  const inTs = incoming.reset_ts;
  const caTs = cached.reset_ts;

  // Case 1 & 2: Both buckets carry real reset timestamps.
  if (inTs !== null && caTs !== null) {
    if (caTs > inTs + RESET_TOLERANCE_MS) {
      return { bucket: cached, source: 'cached', changedCache: false };
    }
    if (inTs > caTs + RESET_TOLERANCE_MS) {
      return { bucket: incoming, source: 'incoming', changedCache: true };
    }

    // Same window: remaining quota is monotonically non-increasing until reset_time changes.
    if (incoming.remaining_fraction !== null && cached.remaining_fraction !== null) {
      if (cached.remaining_fraction < incoming.remaining_fraction - FRACTION_EPSILON) {
        return { bucket: cached, source: 'cached', changedCache: false };
      }
      if (incoming.remaining_fraction < cached.remaining_fraction - FRACTION_EPSILON) {
        return { bucket: incoming, source: 'incoming', changedCache: true };
      }
      return { bucket: incoming, source: 'incoming', changedCache: false };
    }

    if (incoming.remaining_amount !== null && cached.remaining_amount !== null) {
      if (cached.remaining_amount < incoming.remaining_amount) {
        return { bucket: cached, source: 'cached', changedCache: false };
      }
      if (incoming.remaining_amount < cached.remaining_amount) {
        return { bucket: incoming, source: 'incoming', changedCache: true };
      }
      return { bucket: incoming, source: 'incoming', changedCache: false };
    }

    return { bucket: incoming, source: 'incoming', changedCache: false };
  }

  // Case 3a: Incoming is an unused/sentinel bucket (e.g. 100%, 1970-01-01) while cache has a real window.
  if (inTs === null && caTs !== null) {
    const inFull = incoming.remaining_fraction !== null && incoming.remaining_fraction >= 0.999;
    if (caTs > now && inFull && (cached.remaining_fraction === null || cached.remaining_fraction < 0.999)) {
      return { bucket: cached, source: 'cached', changedCache: false };
    }
    if (caTs <= now && inFull) {
      return { bucket: incoming, source: 'incoming', changedCache: true };
    }
    return { bucket: incoming, source: 'incoming', changedCache: false };
  }

  // Case 3b: Incoming has a real window while cache is an unused/sentinel bucket.
  if (inTs !== null && caTs === null) {
    if (inTs > now) {
      return { bucket: incoming, source: 'incoming', changedCache: true };
    }
    const caFull = cached.remaining_fraction !== null && cached.remaining_fraction >= 0.999;
    if (caFull && cached.observedAt > inTs) {
      return { bucket: cached, source: 'cached', changedCache: false };
    }
    return { bucket: incoming, source: 'incoming', changedCache: false };
  }

  // Case 4: Neither has a real reset_time (e.g. synthetic fixtures with only reset_in_seconds).
  return { bucket: incoming, source: 'incoming', changedCache: false };
}

function materializeBucket(baseRaw, winner, now) {
  const out = baseRaw && typeof baseRaw === 'object' ? { ...baseRaw } : {};
  if (winner.remaining_fraction !== null) {
    out.remaining_fraction = winner.remaining_fraction;
  } else {
    delete out.remaining_fraction;
  }
  if (winner.remaining_amount !== null) {
    out.remaining_amount = winner.remaining_amount;
  } else {
    delete out.remaining_amount;
  }
  if (winner.reset_time !== null) {
    out.reset_time = winner.reset_time;
  } else {
    delete out.reset_time;
  }
  if (winner.reset_ts !== null) {
    out.reset_in_seconds = Math.max(0, Math.round((winner.reset_ts - now) / 1000));
  } else if (winner.reset_in_seconds !== null) {
    out.reset_in_seconds = winner.reset_in_seconds;
  } else {
    delete out.reset_in_seconds;
  }
  return out;
}

function readRawQuotaCache(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAccountBucketMap(rawBuckets, fallbackObservedAt, now, maxAgeMs) {
  const buckets = {};
  if (!rawBuckets || typeof rawBuckets !== 'object') return buckets;
  for (const [id, raw] of Object.entries(rawBuckets)) {
    const norm = normalizeQuotaBucket(raw, fallbackObservedAt);
    if (norm && now - norm.observedAt <= maxAgeMs) {
      buckets[id] = norm;
    }
  }
  return buckets;
}

export function readAllAccountQuotas({ baseDir = configDir(homedir()), now = Date.now(), maxAgeMs = MAX_ACCOUNT_QUOTA_RETENTION_MS } = {}) {
  const parsed = readRawQuotaCache(quotaCachePath(baseDir));
  if (!parsed) return {};

  const out = {};
  if (parsed.accounts && typeof parsed.accounts === 'object') {
    for (const [key, entry] of Object.entries(parsed.accounts)) {
      if (!entry || typeof entry !== 'object') continue;
      const updatedAt = nonNeg(entry.updatedAt) ?? nonNeg(parsed.updatedAt) ?? now;
      const buckets = normalizeAccountBucketMap(entry.buckets, updatedAt, now, maxAgeMs);
      if (Object.keys(buckets).length > 0) {
        out[key] = { accountKey: key, updatedAt, buckets };
      }
    }
  }

  // Backward compatibility: include legacy top-level buckets if absent from accounts map.
  if (parsed.buckets && typeof parsed.buckets === 'object') {
    const topKey = typeof parsed.accountKey === 'string' && parsed.accountKey.trim() ? parsed.accountKey.trim() : 'default';
    if (!out[topKey]) {
      const updatedAt = nonNeg(parsed.updatedAt) ?? now;
      const buckets = normalizeAccountBucketMap(parsed.buckets, updatedAt, now, maxAgeMs);
      if (Object.keys(buckets).length > 0) {
        out[topKey] = { accountKey: topKey, updatedAt, buckets };
      }
    }
  }

  return out;
}

export function readSharedQuota({ baseDir = configDir(homedir()), now = Date.now(), accountKey = 'default' } = {}) {
  const parsed = readRawQuotaCache(quotaCachePath(baseDir));
  if (!parsed) return null;

  // Prefer explicit per-account cache entry when present (multi-account safe).
  const accountEntry = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts[accountKey] : null;
  if (accountEntry && typeof accountEntry === 'object' && accountEntry.buckets && typeof accountEntry.buckets === 'object') {
    const updatedAt = nonNeg(accountEntry.updatedAt) ?? nonNeg(parsed.updatedAt) ?? now;
    const buckets = normalizeAccountBucketMap(accountEntry.buckets, updatedAt, now, MAX_CACHE_AGE_MS);
    return {
      accountKey,
      updatedAt,
      buckets,
    };
  }

  if (!parsed.buckets || typeof parsed.buckets !== 'object') return null;
  const cachedAccount = typeof parsed.accountKey === 'string' ? parsed.accountKey : 'default';
  if (accountKey !== 'default' && cachedAccount !== 'default' && cachedAccount !== accountKey) {
    return null;
  }
  const updatedAt = nonNeg(parsed.updatedAt) ?? now;
  const buckets = normalizeAccountBucketMap(parsed.buckets, updatedAt, now, MAX_CACHE_AGE_MS);
  return {
    accountKey: cachedAccount,
    updatedAt,
    buckets,
  };
}

export function mergeQuotaSnapshots(snapshots = [], now = Date.now()) {
  const merged = {};
  for (const item of snapshots) {
    if (!item || typeof item !== 'object') continue;
    const isWrapped = Object.hasOwn(item, 'quota');
    const snap = isWrapped ? item.quota : item;
    const obs = isWrapped ? nonNeg(item.observedAt) ?? now : now;
    if (!snap || typeof snap !== 'object') continue;
    for (const [id, raw] of Object.entries(snap)) {
      const incoming = normalizeQuotaBucket(raw, obs);
      if (!incoming) continue;
      const existing = merged[id] || null;
      const { bucket } = pickFresherBucket(incoming, existing, now);
      if (bucket) merged[id] = bucket;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

export function syncSharedQuota(
  rawQuota,
  { baseDir = configDir(homedir()), now = Date.now(), accountKey = 'default' } = {},
) {
  if (!rawQuota || typeof rawQuota !== 'object') return rawQuota;

  const existingCache = readSharedQuota({ baseDir, now, accountKey });
  const nextCacheBuckets = existingCache ? { ...existingCache.buckets } : {};
  const mergedQuota = { ...rawQuota };

  let anyAdopted = false;
  let cacheDirty = !existingCache;

  for (const [id, rawBucket] of Object.entries(rawQuota)) {
    if (!rawBucket || typeof rawBucket !== 'object' || rawBucket.disabled === true) continue;
    const incoming = normalizeQuotaBucket(rawBucket, now);
    if (!incoming) continue;

    const cached = nextCacheBuckets[id] || null;
    const { bucket: winner, source, changedCache } = pickFresherBucket(incoming, cached, now);
    if (!winner) continue;

    if (source === 'cached') {
      mergedQuota[id] = materializeBucket(rawBucket, winner, now);
      anyAdopted = true;
    } else if (changedCache) {
      nextCacheBuckets[id] = winner;
      cacheDirty = true;
    }
  }

  if (cacheDirty && Object.keys(nextCacheBuckets).length > 0) {
    try {
      const resolvedKey = accountKey !== 'default' ? accountKey : existingCache?.accountKey || 'default';
      const existingAccounts = readAllAccountQuotas({ baseDir, now });
      const accounts = {};
      for (const [k, entry] of Object.entries(existingAccounts)) {
        accounts[k] = {
          updatedAt: entry.updatedAt,
          buckets: entry.buckets,
        };
      }
      accounts[resolvedKey] = {
        updatedAt: now,
        buckets: nextCacheBuckets,
      };
      const payload = {
        version: 2,
        accountKey: resolvedKey,
        updatedAt: now,
        buckets: nextCacheBuckets,
        accounts,
      };
      writeFileAtomic(quotaCachePath(baseDir), JSON.stringify(payload) + '\n');
    } catch {
      // Never fail statusline rendering due to disk issues.
    }
  }

  return anyAdopted ? mergedQuota : rawQuota;
}

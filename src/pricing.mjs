import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, configPath } from './config.mjs';

// Public reference API rates in USD per 1,000,000 tokens (calibrated from models.dev).
// Used as offline fallback when pricing-cache.json has not synced yet.
export const BUILTIN_RATES = Object.freeze([
  Object.freeze({ id: 'claude-opus-4-6', pattern: /opus/i, label: 'Claude Opus', input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 }),
  Object.freeze({ id: 'claude-sonnet-4-6', pattern: /sonnet/i, label: 'Claude Sonnet', input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }),
  Object.freeze({ id: 'claude-haiku-4-5', pattern: /haiku/i, label: 'Claude Haiku', input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 }),
  Object.freeze({ id: 'gemini-4-neon', pattern: /neon/i, label: 'Gemini 4 Neon', input: 3.0, output: 15.0, cacheRead: 0.15, cacheWrite: 3.0 }),
  Object.freeze({ id: 'gemini-4-carbon', pattern: /carbon/i, label: 'Gemini 4 Carbon', input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.0 }),
  Object.freeze({ id: 'gemini-4-argon', pattern: /argon/i, label: 'Gemini 4 Argon', input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.0 }),
  Object.freeze({ id: 'gemini-4-hydrogen', pattern: /hydrogen/i, label: 'Gemini 4 Hydrogen', input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 1.5 }),
  Object.freeze({ id: 'gemini-3.8-flash', pattern: /3\.8.*flash/i, label: 'Gemini 3.8 Flash', input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 }),
  Object.freeze({ id: 'gemini-2.5-pro', pattern: /pro/i, label: 'Gemini Pro', input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 }),
  Object.freeze({ id: 'gemini-2.5-flash', pattern: /flash/i, label: 'Gemini Flash', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 }),
]);

export function pricingCachePath(baseDir = configDir(homedir())) {
  return join(baseDir, 'pricing-cache.json');
}

export function normalizeModelKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:low|medium|high|xhigh|max|latest)\)\s*/gi, '')
    .replace(/-(?:low|medium|high|xhigh|max)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidRateEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const { input, output } = entry;
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0 || input > 500) return false;
  if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0 || output > 1000) return false;
  const cacheRead = entry.cacheRead ?? 0;
  const cacheWrite = entry.cacheWrite ?? input;
  if (typeof cacheRead !== 'number' || !Number.isFinite(cacheRead) || cacheRead < 0 || cacheRead > input * 2) return false;
  if (typeof cacheWrite !== 'number' || !Number.isFinite(cacheWrite) || cacheWrite < 0 || cacheWrite > input * 4) return false;
  return true;
}

const memoCache = { path: null, mtimeMs: -1, data: null };
const memoCustom = { path: null, mtimeMs: -1, data: null };

export function clearPricingMemo() {
  memoCache.path = null;
  memoCache.mtimeMs = -1;
  memoCache.data = null;
  memoCustom.path = null;
  memoCustom.mtimeMs = -1;
  memoCustom.data = null;
}

export function readPricingCache({ baseDir = configDir(homedir()) } = {}) {
  const path = pricingCachePath(baseDir);
  try {
    if (!existsSync(path)) {
      if (memoCache.path === path) clearPricingMemo();
      return null;
    }
    const stat = statSync(path);
    if (memoCache.path === path && memoCache.mtimeMs === stat.mtimeMs) {
      return memoCache.data;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.rates && typeof parsed.rates === 'object') {
      memoCache.path = path;
      memoCache.mtimeMs = stat.mtimeMs;
      memoCache.data = parsed;
      return parsed;
    }
  } catch {
    // Ignore corrupt cache and fall back to built-in rates cleanly.
  }
  return null;
}

function readCustomPricingFromDisk(home = homedir()) {
  const path = configPath(home);
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (memoCustom.path === path && memoCustom.mtimeMs === stat.mtimeMs) {
      return memoCustom.data;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const custom = parsed?.customPricing && typeof parsed.customPricing === 'object' && !Array.isArray(parsed.customPricing)
      ? parsed.customPricing
      : null;
    memoCustom.path = path;
    memoCustom.mtimeMs = stat.mtimeMs;
    memoCustom.data = custom;
    return custom;
  } catch {
    return null;
  }
}

function matchFromMap(normKey, rawLower, ratesMap, sourceLabel) {
  if (!ratesMap || typeof ratesMap !== 'object') return null;

  // 1. Exact normalized ID match (e.g. "gemini-4-neon", "claude-opus-4-6")
  if (normKey && Object.hasOwn(ratesMap, normKey) && isValidRateEntry(ratesMap[normKey])) {
    const r = ratesMap[normKey];
    return {
      id: normKey,
      label: r.label || normKey,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead ?? 0,
      cacheWrite: r.cacheWrite ?? r.input,
      source: sourceLabel,
    };
  }

  // 2. Longest normalized key prefix/substring match (prefer specific version matches)
  let bestKey = null;
  let bestScore = 0;
  for (const [k, r] of Object.entries(ratesMap)) {
    if (!isValidRateEntry(r)) continue;
    const nk = normalizeModelKey(k);
    if (!nk) continue;
    if (normKey === nk) {
      bestKey = k;
      bestScore = 10_000;
      break;
    }
    if ((normKey && (normKey.includes(nk) || nk.includes(normKey))) || rawLower.includes(k.toLowerCase())) {
      const score = nk.length;
      if (score > bestScore) {
        bestScore = score;
        bestKey = k;
      }
    }
  }

  if (bestKey) {
    const r = ratesMap[bestKey];
    return {
      id: bestKey,
      label: r.label || bestKey,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead ?? 0,
      cacheWrite: r.cacheWrite ?? r.input,
      source: sourceLabel,
    };
  }
  return null;
}

export function lookupRates(
  modelName,
  {
    customPricing = undefined,
    pricingCache = undefined,
    useLocalSources = true,
    baseDir = configDir(homedir()),
    home = homedir(),
  } = {},
) {
  const raw = String(modelName || '').trim();
  if (!raw) return null;
  const rawLower = raw.toLowerCase();
  const normKey = normalizeModelKey(raw);

  // Tier 1: User custom overrides (config.json customPricing)
  const customMap = customPricing !== undefined ? customPricing : useLocalSources ? readCustomPricingFromDisk(home) : null;
  const fromCustom = matchFromMap(normKey, rawLower, customMap, 'custom');
  if (fromCustom) return fromCustom;

  // Tier 2: Synced local pricing cache (pricing-cache.json)
  const cacheObj = pricingCache !== undefined ? pricingCache : useLocalSources ? readPricingCache({ baseDir }) : null;
  const fromCache = matchFromMap(normKey, rawLower, cacheObj?.rates, cacheObj?.source ? `cache:${cacheObj.source}` : 'cache');
  if (fromCache) return fromCache;

  // Tier 3: Built-in calibrated fallback table
  for (const entry of BUILTIN_RATES) {
    if (entry.pattern.test(raw)) {
      return {
        id: entry.id,
        label: entry.label,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
        source: 'builtin',
      };
    }
  }
  return null;
}

export function estimateCost({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}, lookupOpts = {}) {
  const rates = lookupRates(model, lookupOpts);
  if (!rates) {
    return { priced: false, costUsd: 0, cacheSavedUsd: 0, rateLabel: null, rateSource: null };
  }
  const safe = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const inTok = safe(input);
  const outTok = safe(output);
  const crTok = safe(cacheRead);
  const cwTok = safe(cacheWrite);

  const costUsd =
    (inTok * rates.input + outTok * rates.output + crTok * rates.cacheRead + cwTok * rates.cacheWrite) / 1_000_000;
  const cacheSavedUsd = (crTok * Math.max(0, rates.input - rates.cacheRead)) / 1_000_000;

  return {
    priced: true,
    costUsd,
    cacheSavedUsd,
    rateLabel: rates.label,
    rateSource: rates.source,
  };
}

export function formatUsd(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(1)}`;
}

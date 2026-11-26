import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflate } from 'node:zlib';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { usageSummaryPath } from './history-scan.mjs';
import {
  clearPricingMemo,
  isValidRateEntry,
  normalizeModelKey,
  pricingCachePath,
  readPricingCache,
} from './pricing.mjs';
import { resolveEffectiveProxy } from './proxy.mjs';

export const PRICING_CACHE_VERSION = 1;
export const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
export const PRICING_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export const PRICING_SOURCES = Object.freeze({
  'models.dev': 'https://models.dev/api.json',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
});

export const PRICING_SOURCE_NAMES = Object.freeze(['auto', 'models.dev', 'litellm']);

const SKIP_MODEL_RE = /(?:audio|tts|image|embedding|live-translate|live-preview|computer-use|vision-only|customtools|20\d{6})/i;
const KEEP_MODEL_RE = /(?:gemini|claude)/i;

function roundRate(n) {
  return Math.round(n * 10_000) / 10_000;
}

export function extractModelsDevRates(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};

  for (const providerKey of ['google', 'anthropic']) {
    const models = payload[providerKey]?.models;
    if (!models || typeof models !== 'object') continue;

    for (const [id, meta] of Object.entries(models)) {
      if (!KEEP_MODEL_RE.test(id) || SKIP_MODEL_RE.test(id)) continue;
      const cost = meta?.cost;
      if (!cost || typeof cost !== 'object') continue;
      const input = Number(cost.input);
      const output = Number(cost.output);
      const cacheRead = cost.cache_read != null ? Number(cost.cache_read) : roundRate(input * 0.1);
      const cacheWrite = cost.cache_write != null ? Number(cost.cache_write) : input;

      const entry = {
        label: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : id,
        input: roundRate(input),
        output: roundRate(output),
        cacheRead: roundRate(cacheRead),
        cacheWrite: roundRate(cacheWrite),
      };
      const normKey = normalizeModelKey(id);
      if (normKey && isValidRateEntry(entry)) {
        out[normKey] = entry;
      }
    }
  }
  return out;
}

export function extractLiteLlmRates(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};

  for (const [rawId, meta] of Object.entries(payload)) {
    if (!meta || typeof meta !== 'object') continue;
    const cleanId = rawId.replace(/^(?:google|gemini|anthropic|vertex_ai)\//i, '');
    if (!KEEP_MODEL_RE.test(cleanId) || SKIP_MODEL_RE.test(cleanId)) continue;
    if (rawId.includes('/') && !/^(?:google|gemini|anthropic)\//i.test(rawId)) continue;

    const rawIn = Number(meta.input_cost_per_token);
    const rawOut = Number(meta.output_cost_per_token);
    if (!Number.isFinite(rawIn) || !Number.isFinite(rawOut) || rawIn <= 0 || rawOut <= 0) continue;

    const input = roundRate(rawIn * 1_000_000);
    const output = roundRate(rawOut * 1_000_000);
    const rawCr = Number(meta.cache_read_input_token_cost);
    const rawCw = Number(meta.cache_creation_input_token_cost);
    const cacheRead = Number.isFinite(rawCr) && rawCr >= 0 ? roundRate(rawCr * 1_000_000) : roundRate(input * 0.1);
    const cacheWrite = Number.isFinite(rawCw) && rawCw >= 0 ? roundRate(rawCw * 1_000_000) : input;

    const normKey = normalizeModelKey(cleanId);
    const entry = { label: cleanId, input, output, cacheRead, cacheWrite };
    if (normKey && isValidRateEntry(entry) && !Object.hasOwn(out, normKey)) {
      out[normKey] = entry;
    }
  }
  return out;
}

function openHttpConnectTunnel(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username || proxy.password) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${auth}`;
    }

    const req = httpRequest({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: timeoutMs,
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => {
      req.destroy(new Error('Proxy CONNECT timeout'));
    });
    req.once('error', reject);
    req.end();
  });
}

export async function fetchJsonWithProxy(
  url,
  {
    proxyUrl = null,
    etag = null,
    timeoutMs = 8000,
    maxBytes = 25 * 1024 * 1024,
    redirectsLeft = 3,
  } = {},
) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`Unsupported URL protocol: ${target.protocol}`);
  }

  const useHttpProxy = Boolean(proxyUrl && /^https?:\/\//i.test(proxyUrl));
  let tunnelTlsSocket = null;
  if (useHttpProxy && target.protocol === 'https:') {
    const rawSocket = await openHttpConnectTunnel(proxyUrl, target.hostname, target.port ? Number(target.port) : 443, timeoutMs);
    tunnelTlsSocket = tlsConnect({
      socket: rawSocket,
      servername: target.hostname,
      ALPNProtocols: ['http/1.1'],
    });
  }

  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'agy-bar-pricing-sync',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate, identity',
    };
    if (etag) headers['If-None-Match'] = etag;

    const reqFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const reqOpts = {
      hostname: target.hostname,
      port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      ...(tunnelTlsSocket ? { createConnection: () => tunnelTlsSocket } : {}),
    };

    const req = reqFn(reqOpts, (res) => {
      const status = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, target).href;
        fetchJsonWithProxy(nextUrl, { proxyUrl, etag, timeoutMs, maxBytes, redirectsLeft: redirectsLeft - 1 })
          .then(resolve, reject);
        return;
      }

      if (status === 304) {
        res.resume();
        resolve({ status: 304, notModified: true, etag: res.headers.etag || etag || null, data: null });
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} from ${target.hostname}`));
        return;
      }

      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = encoding === 'gzip' ? res.pipe(createGunzip()) : encoding === 'deflate' ? res.pipe(createInflate()) : res;

      const chunks = [];
      let totalBytes = 0;
      stream.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          stream.destroy(new Error(`Pricing payload exceeded ${maxBytes} bytes limit`));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({
            status,
            notModified: false,
            etag: res.headers.etag || null,
            data: parsed,
          });
        } catch (err) {
          reject(new Error(`Invalid JSON from ${target.hostname}: ${err.message}`));
        }
      });
    });

    req.once('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.once('error', (err) => {
      try {
        tunnelTlsSocket?.destroy();
      } catch {
        // Ignore cleanup errors.
      }
      reject(err);
    });
    req.end();
  });
}

export function attemptStampPath(baseDir = configDir(homedir())) {
  return join(baseDir, '.pricing-sync-attempt');
}

export function shouldAutoSyncPricing(
  cache,
  {
    now = Date.now(),
    baseDir = configDir(homedir()),
    ttlMs = PRICING_TTL_MS,
    retryCooldownMs = PRICING_RETRY_COOLDOWN_MS,
  } = {},
) {
  if (cache && typeof cache.fetchedAt === 'number' && now - cache.fetchedAt < ttlMs) {
    return false;
  }
  if (cache && typeof cache.lastAttemptAt === 'number' && now - cache.lastAttemptAt < retryCooldownMs) {
    return false;
  }
  const stampFile = attemptStampPath(baseDir);
  if (existsSync(stampFile)) {
    try {
      const rawTs = Number(readFileSync(stampFile, 'utf8').trim());
      const stampTs = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : statSync(stampFile).mtimeMs;
      if (now - stampTs < retryCooldownMs) return false;
    } catch {
      // Ignore stat/read errors.
    }
  }
  return true;
}

export async function syncPricingCache({
  baseDir = configDir(homedir()),
  proxyConfig = null,
  source = 'auto',
  force = false,
  now = Date.now(),
  timeoutMs = 8000,
  fetchFn = fetchJsonWithProxy,
} = {}) {
  const existing = readPricingCache({ baseDir });
  const cacheFile = pricingCachePath(baseDir);

  let proxyUrl = null;
  if (proxyConfig !== false) {
    try {
      const resolved = await resolveEffectiveProxy(proxyConfig);
      if (resolved.active && resolved.url) proxyUrl = resolved.url;
    } catch {
      proxyUrl = null;
    }
  }

  const sourcePlan =
    source === 'models.dev'
      ? ['models.dev']
      : source === 'litellm'
        ? ['litellm']
        : ['models.dev', 'litellm'];

  const errors = [];
  for (const srcName of sourcePlan) {
    const url = PRICING_SOURCES[srcName];
    const etag = !force && existing?.source === srcName ? existing.etag || null : null;
    try {
      const res = await fetchFn(url, { proxyUrl, etag, timeoutMs });
      if (res.notModified && existing) {
        const refreshed = {
          ...existing,
          fetchedAt: now,
          lastAttemptAt: now,
          etag: res.etag || existing.etag || null,
        };
        writeFileAtomic(cacheFile, JSON.stringify(refreshed, null, 2) + '\n');
        clearPricingMemo();
        return {
          ok: true,
          updated: false,
          notModified: true,
          source: srcName,
          count: Object.keys(existing.rates || {}).length,
          fetchedAt: now,
          cachePath: cacheFile,
        };
      }

      const rates = srcName === 'models.dev' ? extractModelsDevRates(res.data) : extractLiteLlmRates(res.data);
      const count = Object.keys(rates).length;
      if (count < 5) {
        throw new Error(`Sanity guard rejected ${srcName} payload (only ${count} valid rates)`);
      }

      const nextCache = {
        version: PRICING_CACHE_VERSION,
        source: srcName,
        fetchedAt: now,
        lastAttemptAt: now,
        etag: res.etag || null,
        rates,
      };
      writeFileAtomic(cacheFile, JSON.stringify(nextCache, null, 2) + '\n');
      clearPricingMemo();

      // Invalidate cached usage-summary.json so todayCostUsd recomputes with new rates on next refresh.
      try {
        rmSync(usageSummaryPath(baseDir), { force: true });
      } catch {
        // Ignore cleanup errors.
      }

      return {
        ok: true,
        updated: true,
        notModified: false,
        source: srcName,
        count,
        fetchedAt: now,
        cachePath: cacheFile,
      };
    } catch (err) {
      errors.push(`${srcName}: ${err.message}`);
    }
  }

  // Record backoff attempt while preserving any previously synced rates intact.
  try {
    writeFileAtomic(attemptStampPath(baseDir), `${now}\n`);
    if (existing) {
      writeFileAtomic(cacheFile, JSON.stringify({ ...existing, lastAttemptAt: now }, null, 2) + '\n');
      clearPricingMemo();
    }
  } catch {
    // Ignore write failures silently.
  }

  return {
    ok: false,
    updated: false,
    notModified: false,
    error: errors.join('; '),
    count: Object.keys(existing?.rates || {}).length,
    cachePath: cacheFile,
  };
}

export function maybeTriggerBackgroundPricingSync({
  enabled = true,
  baseDir = configDir(homedir()),
  now = Date.now(),
  env = process.env,
  cliPath = fileURLToPath(new URL('../bin/agy-bar.mjs', import.meta.url)),
  spawnFn = spawn,
} = {}) {
  if (!enabled || env?.AGY_BAR_NO_AUTO_SYNC === '1') return false;
  const cache = readPricingCache({ baseDir });
  if (!shouldAutoSyncPricing(cache, { now, baseDir })) return false;

  try {
    // Write single-flight attempt stamp first so concurrent terminals don't spawn duplicate syncs.
    writeFileAtomic(attemptStampPath(baseDir), `${now}\n`);
    const child = spawnFn(process.execPath, [cliPath, 'pricing', 'sync', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...env, AGY_BAR_NO_AUTO_SYNC: '1' },
    });
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

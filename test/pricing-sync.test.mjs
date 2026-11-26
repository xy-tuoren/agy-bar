import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearPricingMemo, estimateCost, lookupRates, normalizeModelKey, readPricingCache } from '../src/pricing.mjs';
import {
  extractLiteLlmRates,
  extractModelsDevRates,
  maybeTriggerBackgroundPricingSync,
  PRICING_RETRY_COOLDOWN_MS,
  PRICING_TTL_MS,
  shouldAutoSyncPricing,
  syncPricingCache,
} from '../src/pricing-sync.mjs';

test('extractModelsDevRates and extractLiteLlmRates filter Google/Anthropic chat models and enforce sanity bounds', () => {
  const modelsDevSample = {
    google: {
      models: {
        'gemini-4-neon': { name: 'Gemini 4 Neon', cost: { input: 3, output: 15, cache_read: 0.15 } },
        'gemini-4-carbon': { name: 'Gemini 4 Carbon', cost: { input: 2, output: 10, cache_read: 0.1 } },
        'gemini-4-argon': { name: 'Gemini 4 Argon', cost: { input: 2, output: 10, cache_read: 0.1 } },
        'gemini-4-hydrogen': { name: 'Gemini 4 Hydrogen', cost: { input: 1.5, output: 7.5, cache_read: 0.075 } },
        'gemini-2.5-pro-preview-tts': { name: 'TTS', cost: { input: 1, output: 20 } },
        'gemini-broken': { name: 'Broken', cost: { input: 99999, output: 10 } },
      },
    },
    anthropic: {
      models: {
        'claude-opus-4-6': { name: 'Claude Opus 4.6', cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
        'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        'claude-sonnet-4-5-20250929': { name: 'Dated Snapshot', cost: { input: 3, output: 15 } },
      },
    },
  };

  const extracted = extractModelsDevRates(modelsDevSample);
  assert.equal(extracted['gemini-4-neon']?.input, 3);
  assert.equal(extracted['gemini-4-neon']?.cacheRead, 0.15);
  assert.equal(extracted['claude-opus-4-6']?.output, 25);
  assert.equal(extracted['gemini-2.5-pro-preview-tts'], undefined);
  assert.equal(extracted['gemini-broken'], undefined);
  assert.equal(extracted['claude-sonnet-4-5-20250929'], undefined);

  const litellmSample = {
    'gemini/gemini-2.5-pro': {
      input_cost_per_token: 0.00000125,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.000000125,
    },
    'claude-opus-4-6': {
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_read_input_token_cost: 0.0000005,
      cache_creation_input_token_cost: 0.00000625,
    },
    'openai/gpt-5': { input_cost_per_token: 0.00001, output_cost_per_token: 0.00003 },
  };
  const fromLite = extractLiteLlmRates(litellmSample);
  assert.equal(fromLite['gemini-2-5-pro']?.input, 1.25);
  assert.equal(fromLite['claude-opus-4-6']?.cacheWrite, 6.25);
  assert.equal(fromLite['gpt-5'], undefined);
});

test('lookupRates enforces 3-tier priority (custom > cache > builtin) and normalizes model names', () => {
  assert.equal(normalizeModelKey('Gemini 4 Neon (XHigh)'), 'gemini-4-neon');
  assert.equal(normalizeModelKey('Claude Opus 4.6'), 'claude-opus-4-6');

  const fakeCache = {
    source: 'models.dev',
    rates: {
      'gemini-4-neon': { label: 'Gemini 4 Neon', input: 3.5, output: 16.0, cacheRead: 0.2, cacheWrite: 3.5 },
    },
  };
  const custom = {
    'gemini-4-neon': { input: 9.0, output: 30.0, cacheRead: 0.9, cacheWrite: 9.0 },
  };

  // Tier 1: custom wins over cache and builtin.
  const tier1 = lookupRates('Gemini 4 Neon (High)', { customPricing: custom, pricingCache: fakeCache, useLocalSources: false });
  assert.equal(tier1.source, 'custom');
  assert.equal(tier1.input, 9.0);

  // Tier 2: cache wins over builtin.
  const tier2 = lookupRates('Gemini 4 Neon', { customPricing: null, pricingCache: fakeCache, useLocalSources: false });
  assert.equal(tier2.source, 'cache:models.dev');
  assert.equal(tier2.input, 3.5);

  // Tier 3: builtin fallback when neither custom nor cache matches.
  const tier3 = lookupRates('Claude Opus 4.6', { customPricing: null, pricingCache: fakeCache, useLocalSources: false });
  assert.equal(tier3.source, 'builtin');
  assert.equal(tier3.input, 5.0);
  assert.equal(tier3.output, 25.0);

  const est = estimateCost(
    { model: 'Gemini 4 Neon', input: 1_000_000, output: 100_000, cacheRead: 1_000_000 },
    { customPricing: null, pricingCache: fakeCache, useLocalSources: false },
  );
  // 3.5 + 1.6 + 0.2 = 5.3
  assert.ok(Math.abs(est.costUsd - 5.3) < 1e-6);
  assert.equal(est.rateSource, 'cache:models.dev');
});

test('syncPricingCache supports ETag 304, fallback to litellm, sanity guard, and 24h SWR trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-psync-'));
  try {
    clearPricingMemo();
    const t0 = 1_795_700_000_000;
    const validPayload = {
      google: {
        models: {
          'gemini-4-neon': { name: 'Gemini 4 Neon', cost: { input: 3, output: 15, cache_read: 0.15 } },
          'gemini-4-carbon': { name: 'Gemini 4 Carbon', cost: { input: 2, output: 10, cache_read: 0.1 } },
          'gemini-4-argon': { name: 'Gemini 4 Argon', cost: { input: 2, output: 10, cache_read: 0.1 } },
          'gemini-4-hydrogen': { name: 'Gemini 4 Hydrogen', cost: { input: 1.5, output: 7.5, cache_read: 0.075 } },
          'gemini-2.5-pro': { name: 'Gemini 2.5 Pro', cost: { input: 1.25, output: 10, cache_read: 0.125 } },
        },
      },
      anthropic: {
        models: {
          'claude-opus-4-6': { name: 'Claude Opus 4.6', cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
        },
      },
    };

    // 1. First sync succeeds and writes pricing-cache.json atomically.
    const res1 = await syncPricingCache({
      baseDir: dir,
      proxyConfig: false,
      now: t0,
      fetchFn: async () => ({ status: 200, notModified: false, etag: '"v1"', data: validPayload }),
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.updated, true);
    assert.equal(res1.count, 6);
    assert.ok(existsSync(res1.cachePath));

    const cached = readPricingCache({ baseDir: dir });
    assert.equal(cached.etag, '"v1"');
    assert.equal(shouldAutoSyncPricing(cached, { now: t0 + 1000, baseDir: dir }), false);
    assert.equal(shouldAutoSyncPricing(cached, { now: t0 + PRICING_TTL_MS + 1000, baseDir: dir }), true);

    // 2. Subsequent sync sends ETag and handles 304 cleanly without wiping rates.
    let sentEtag = null;
    const res2 = await syncPricingCache({
      baseDir: dir,
      proxyConfig: false,
      now: t0 + PRICING_TTL_MS + 5000,
      fetchFn: async (_url, { etag }) => {
        sentEtag = etag;
        return { status: 304, notModified: true, etag: '"v1"', data: null };
      },
    });
    assert.equal(sentEtag, '"v1"');
    assert.equal(res2.ok, true);
    assert.equal(res2.notModified, true);
    assert.equal(res2.count, 6);

    // 3. Sanity guard rejects empty/malformed upstream payload and preserves existing cache.
    const resBad = await syncPricingCache({
      baseDir: dir,
      proxyConfig: false,
      force: true,
      now: t0 + PRICING_TTL_MS * 2,
      fetchFn: async () => ({ status: 200, notModified: false, etag: null, data: { google: { models: {} } } }),
    });
    assert.equal(resBad.ok, false);
    assert.equal(readPricingCache({ baseDir: dir })?.rates?.['gemini-4-neon']?.input, 3);
    // Cooldown prevents immediate retry after failure.
    assert.equal(
      shouldAutoSyncPricing(readPricingCache({ baseDir: dir }), {
        now: t0 + PRICING_TTL_MS * 2 + 1000,
        baseDir: dir,
      }),
      false,
    );

    // 4. After cooldown, background SWR spawns detached worker exactly once (single-flight).
    let spawnCount = 0;
    const triggerTime = t0 + PRICING_TTL_MS * 2 + PRICING_RETRY_COOLDOWN_MS + 5000;
    const spawned1 = maybeTriggerBackgroundPricingSync({
      enabled: true,
      baseDir: dir,
      now: triggerTime,
      env: {},
      spawnFn: () => {
        spawnCount += 1;
        return { unref() {} };
      },
    });
    const spawned2 = maybeTriggerBackgroundPricingSync({
      enabled: true,
      baseDir: dir,
      now: triggerTime + 100,
      env: {},
      spawnFn: () => {
        spawnCount += 1;
        return { unref() {} };
      },
    });
    assert.equal(spawned1, true);
    assert.equal(spawned2, false);
    assert.equal(spawnCount, 1);
  } finally {
    clearPricingMemo();
    rmSync(dir, { recursive: true, force: true });
  }
});

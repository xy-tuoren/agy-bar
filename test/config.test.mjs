import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyConfigCommand, DEFAULT_CONFIG, loadConfig, normalizeConfig, PRESETS } from '../src/config.mjs';

test('normalizeConfig falls back cleanly on invalid input', () => {
  const cfg = normalizeConfig({ preset: 'unknown', theme: 'bad', barWidth: 999, show: { git: 'nope' } });
  assert.equal(cfg.preset, DEFAULT_CONFIG.preset);
  assert.equal(cfg.theme, DEFAULT_CONFIG.theme);
  assert.equal(cfg.barWidth, 14);
  assert.equal(cfg.show.git, true);
});

test('applyConfigCommand persists presets, themes, bar styles, toggles, and reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-cfg-'));
  const file = join(dir, 'config.json');
  try {
    let res = applyConfigCommand(['preset', 'compact'], file);
    assert.equal(res.saved, true);
    assert.equal(res.config.preset, 'compact');
    assert.equal(res.config.show.cache, PRESETS.compact.cache);

    res = applyConfigCommand(['theme', 'nord'], file);
    assert.equal(res.config.theme, 'nord');

    res = applyConfigCommand(['bar-style', 'smooth'], file);
    assert.equal(res.config.barStyle, 'smooth');

    res = applyConfigCommand(['set', 'colorMode', 'distinct'], file);
    assert.equal(res.config.colorMode, 'distinct');

    res = applyConfigCommand(['bar-style', 'line'], file);
    assert.equal(res.config.barStyle, 'line');

    res = applyConfigCommand(['enable', 'cache', 'capacity'], file);
    assert.equal(res.config.show.cache, true);
    assert.equal(res.config.show.capacity, true);
    assert.deepEqual(res.overrides, { capacity: true, cache: true });

    res = applyConfigCommand(['set', 'barWidth', '8', 'show.git', 'off'], file);
    assert.equal(res.config.barWidth, 8);
    assert.equal(res.config.show.git, false);

    res = applyConfigCommand(['set', 'cacheTtlSec', '240', 'ledger', 'off', 'modelThreshold.claude.warn', '60', 'modelThreshold.claude.danger', '80'], file);
    assert.equal(res.config.cacheTtlSec, 240);
    assert.equal(res.config.ledger, false);
    assert.deepEqual(res.config.modelThresholds.claude, { warn: 60, danger: 80 });

    // Ensure disk JSON only stores compact overrides.
    const rawOnDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(rawOnDisk.show, { git: false, capacity: true, cache: true });
    assert.deepEqual(rawOnDisk.modelThresholds, { claude: { warn: 60, danger: 80 } });

    res = applyConfigCommand(['reset'], file);
    assert.equal(res.config.preset, 'dashboard');
    assert.equal(res.config.theme, 'auto');
    assert.deepEqual(res.overrides, {});
    assert.equal(loadConfig(file).preset, 'dashboard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyConfigCommand rejects unknown items and invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bar-cfg-err-'));
  const file = join(dir, 'config.json');
  try {
    assert.throws(() => applyConfigCommand(['theme', 'rainbow'], file), /Invalid theme/);
    assert.throws(() => applyConfigCommand(['preset', 'giant'], file), /Invalid preset/);
    assert.throws(() => applyConfigCommand(['disable', 'nonexistent'], file), /Unknown item/);
    assert.throws(() => applyConfigCommand(['set', 'barWidth', '99'], file), /between 4 and 14/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

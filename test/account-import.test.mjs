import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodeCockpitAccountJson,
  deriveAliasFromAccount,
  discoverCockpitToolsDataDir,
  extractCockpitQuotaBuckets,
  importExternalAccounts,
} from '../src/account-import.mjs';
import { formatAccountTable, listAccountsWithQuota } from '../src/account-quota.mjs';
import { decodeGoKeyringValue, parseAgyTokenPayload, switchToAccount } from '../src/account-store.mjs';
import { createMemoryKeyring, readActiveAgyCredential, writeActiveAgyCredential } from '../src/keyring.mjs';

function sealCockpitEnvelope(keyBuf, payloadObj) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(payloadObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Match Rust aes-gcm crate format: ciphertext + 16-byte tag concatenated.
  const combined = Buffer.concat([body, tag]);
  return {
    version: 1,
    kind: 'antigravity-account',
    algorithm: 'AES-256-GCM',
    key_id: 'local-secure-account-storage-v1',
    nonce: nonce.toString('base64'),
    ciphertext: combined.toString('base64'),
    encrypted_at: Math.floor(Date.now() / 1000),
  };
}

test('imports encrypted Cockpit Tools accounts, seeds passive quota cache, skips disabled, and supports switching', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-cockpit-home-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  const cockpitDir = join(home, '.cockpit_tools');
  const accountsDir = join(cockpitDir, 'accounts');
  mkdirSync(accountsDir, { recursive: true });

  try {
    const keyBuf = randomBytes(32);
    writeFileSync(join(cockpitDir, 'secure-account-storage.key'), keyBuf.toString('base64'), 'utf8');

    const now = Date.parse('2026-11-27T20:40:00Z');
    const expiryTs = Math.floor((now + 3600_000) / 1000);

    const acctUltra = {
      id: 'uuid-1',
      email: 'alpha01@gmail.com',
      notes: 'Main Ultra',
      disabled: false,
      created_at: Math.floor(now / 1000) - 86400,
      last_used: Math.floor(now / 1000) - 600,
      token: {
        access_token: 'ya29.alpha-access',
        refresh_token: '1//alpha-refresh',
        expires_in: 3599,
        expiry_timestamp: expiryTs,
        token_type: 'Bearer',
        email: 'alpha01@gmail.com',
        is_gcp_tos: false,
      },
      quota: {
        subscription_tier: 'ULTRA',
        quota_summary_groups: [
          {
            id: 'gemini',
            name: 'Gemini',
            windows: [
              { id: 'gemini-5h', period: '5h', percentage: 98, reset_time: '2026-11-28T00:51:00Z' },
              { id: 'gemini-weekly', period: 'weekly', percentage: 56, reset_time: '2026-12-02T23:13:00Z' },
            ],
          },
          {
            id: 'claude',
            name: 'Claude',
            windows: [
              { id: '3p-5h', period: '5h', percentage: 100, reset_time: '1970-01-01T00:00:00Z' },
              { id: '3p-weekly', period: 'weekly', percentage: 100, reset_time: '1970-01-01T00:00:00Z' },
            ],
          },
        ],
      },
    };

    const acctFree = {
      id: 'uuid-2',
      email: 'beta02@gmail.com',
      disabled: false,
      token: {
        access_token: 'ya29.beta-access',
        refresh_token: '1//beta-refresh',
        expiry_timestamp: expiryTs,
        token_type: 'Bearer',
      },
      quota: { subscription_tier: 'FREE' },
    };

    const acctDisabled = {
      id: 'uuid-3',
      email: 'revoked@gmail.com',
      disabled: true,
      disabled_reason: 'invalid_grant',
      token: {
        access_token: 'ya29.revoked',
        refresh_token: '1//revoked',
        expiry_timestamp: expiryTs,
        token_type: 'Bearer',
      },
    };

    writeFileSync(join(accountsDir, 'uuid-1.json'), JSON.stringify(sealCockpitEnvelope(keyBuf, acctUltra)), 'utf8');
    writeFileSync(join(accountsDir, 'uuid-2.json'), JSON.stringify(acctFree), 'utf8'); // plaintext also supported
    writeFileSync(join(accountsDir, 'uuid-3.json'), JSON.stringify(sealCockpitEnvelope(keyBuf, acctDisabled)), 'utf8');
    writeFileSync(join(accountsDir, 'uuid-1.json.bak'), 'ignored-backup', 'utf8');

    assert.equal(discoverCockpitToolsDataDir({ home, env: {} }), cockpitDir);

    const keyring = createMemoryKeyring();
    // Simulate alpha01 already being the currently active agy login before import.
    writeActiveAgyCredential(
      JSON.stringify({ token: { access_token: 'ya29.alpha-live', refresh_token: '1//alpha-refresh' }, auth_method: 'consumer' }),
      { home, keyring },
    );

    // Dry run does not mutate vault or keyring.
    const dry = importExternalAccounts({ dryRun: true, home, env: {}, baseDir, keyring, now });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.candidates.length, 2);
    assert.equal(dry.skipped.length, 1);
    assert.equal(listAccountsWithQuota({ baseDir, now }).length, 0);

    // Real import writes into keyring vault, seeds passive quota cache, and auto-links active login.
    const res = importExternalAccounts({ home, env: {}, baseDir, keyring, now });
    assert.equal(res.source, 'cockpit-tools');
    assert.equal(res.imported.length, 2);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.seededQuotas, 1);
    assert.equal(res.detectedActiveAlias, 'Main-Ultra');

    const rows = listAccountsWithQuota({ baseDir, now });
    assert.equal(rows.length, 2);
    const alpha = rows.find((r) => r.alias === 'Main-Ultra');
    const beta = rows.find((r) => r.alias === 'beta02');
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.isActive, true);
    assert.equal(alpha.tier, 'ULTRA');
    assert.equal(alpha.maskedEmail, 'al***@gmail.com');
    assert.equal(alpha.gemini.fiveHourPct, 98);
    assert.equal(alpha.gemini.weeklyPct, 56);
    assert.equal(alpha.claude.fiveHourPct, 100);
    assert.equal(beta.tier, 'FREE');

    const table = formatAccountTable(rows, { color: false, now });
    assert.ok(table.includes('[ULTRA]'));
    assert.ok(table.includes('[FREE]'));

    // Switching to an imported Cockpit Tools account writes valid agy OAuth JSON into active credentials.
    switchToAccount('Main-Ultra', { baseDir, home, keyring, now });
    const active = readActiveAgyCredential({ home, keyring });
    const parsedActive = JSON.parse(active.raw);
    assert.equal(parsedActive.auth_method, 'consumer');
    assert.equal(parsedActive.token.access_token, 'ya29.alpha-access');
    assert.equal(parsedActive.token.refresh_token, '1//alpha-refresh');
    assert.equal(parsedActive.token.token_type, 'Bearer');
    assert.ok(Number.isFinite(Date.parse(parsedActive.token.expiry)));

    // Re-importing is idempotent (updates instead of duplicating).
    const res2 = importExternalAccounts({ home, env: {}, baseDir, keyring, now: now + 1000 });
    assert.equal(res2.imported.length, 0);
    assert.equal(res2.updated.length, 2);
    assert.equal(res2.total, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('imports exported flat JSON file and handles go-keyring-base64 encoded tokens', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-json-import-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  const exportFile = join(home, 'cockpit-export.json');
  try {
    const exported = [
      { email: 'gamma@example.com', refresh_token: '1//gamma-ref' },
      { email: 'delta@example.com', refreshToken: '1//delta-ref', accessToken: 'ya29.delta' },
    ];
    writeFileSync(exportFile, JSON.stringify(exported), 'utf8');

    const keyring = createMemoryKeyring();
    const res = importExternalAccounts({ targetPath: exportFile, baseDir, home, keyring });
    assert.equal(res.source, 'file');
    assert.equal(res.imported.length, 2);

    switchToAccount('gamma', { baseDir, home, keyring });
    const activeGamma = JSON.parse(readActiveAgyCredential({ home, keyring }).raw);
    assert.equal(activeGamma.token.refresh_token, '1//gamma-ref');
    // Refresh-token-only export sets epoch expiry so agy refreshes seamlessly on startup.
    assert.equal(activeGamma.token.expiry, '1970-01-01T00:00:00Z');

    // go-keyring-base64: prefix is transparently decoded by parseAgyTokenPayload.
    const rawJson = JSON.stringify({ token: { access_token: 'a', refresh_token: 'r' }, auth_method: 'consumer' });
    const wrapped = `go-keyring-base64:${Buffer.from(rawJson, 'utf8').toString('base64')}`;
    assert.equal(decodeGoKeyringValue(wrapped), rawJson);
    const parsed = parseAgyTokenPayload(wrapped);
    assert.equal(parsed.hasRefreshToken, true);
    assert.equal(parsed.raw, wrapped);

    assert.equal(deriveAliasFromAccount('xy060734@gmail.com'), 'xy060734');
    assert.equal(extractCockpitQuotaBuckets(null), null);
    assert.throws(() => decodeCockpitAccountJson('{"algorithm":"AES-256-GCM","nonce":"a","ciphertext":"b"}', null));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  computeSwapHint,
  evaluateFamilyQuota,
  formatAccountTable,
  listAccountsWithQuota,
  maybeAutoSwitchAccount,
  pickNextBestAccount,
  sanitizeAccountForJson,
} from '../src/account-quota.mjs';
import { applyConfigCommand, loadConfig } from '../src/config.mjs';
import { renderStatusline } from '../src/render.mjs';
import {
  accountIndexPath,
  accountLockPath,
  accountsDir,
  accountVaultFilePath,
  exportEncryptedBackup,
  importEncryptedBackup,
  maskEmail,
  parseAgyTokenPayload,
  prepareForNewAccountLogin,
  removeAccount,
  renameAccount,
  restorePreservedLogin,
  saveCurrentAccount,
  switchToAccount,
  syncActiveAccountBeforeLaunch,
} from '../src/account-store.mjs';
import { createMemoryKeyring, readActiveAgyCredential, writeActiveAgyCredential } from '../src/keyring.mjs';
import { hashAccountIdentifier, readAllAccountQuotas, syncSharedQuota } from '../src/quota-sync.mjs';

function makeFakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function makeFakeToken({ email, sub, access, refresh, expiry = '2026-11-27T12:00:00Z' }) {
  return JSON.stringify({
    token: {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expiry,
    },
    auth_method: 'oauth',
    id_token: makeFakeJwt({ email, sub }),
  });
}

test('account save, switch with hourly refresh writeback, atomic rollback, rename, and remove', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-acct-home-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  try {
    const keyring = createMemoryKeyring();
    const tokA1 = makeFakeToken({ email: 'alice@example.com', sub: 'sub-a', access: 'acc-a-v1', refresh: 'ref-a' });
    const tokA2 = makeFakeToken({ email: 'alice@example.com', sub: 'sub-a', access: 'acc-a-v2-refreshed', refresh: 'ref-a' });
    const tokB1 = makeFakeToken({ email: 'bob@example.com', sub: 'sub-b', access: 'acc-b-v1', refresh: 'ref-b' });

    // Save Account A ("work") into keychain vault.
    writeActiveAgyCredential(tokA1, { home, keyring });
    const savedA = saveCurrentAccount({ alias: 'work', baseDir, home, keyring, now: 1000 });
    assert.equal(savedA.action, 'saved');
    assert.equal(savedA.account.alias, 'work');
    assert.equal(savedA.account.maskedEmail, 'al***@example.com');
    assert.equal(savedA.account.storageBackend, 'keychain');
    // Plaintext email must never be written to index.json.
    const indexRaw = readFileSync(accountIndexPath(baseDir), 'utf8');
    assert.ok(!indexRaw.toLowerCase().includes('alice@example.com'));
    assert.ok(!indexRaw.includes('acc-a-v1'));
    assert.equal(existsSync(accountVaultFilePath(baseDir)), false);

    // Save Account B ("alt1").
    writeActiveAgyCredential(tokB1, { home, keyring });
    const savedB = saveCurrentAccount({ alias: 'alt1', baseDir, home, keyring, now: 2000 });
    assert.equal(savedB.action, 'saved');
    assert.equal(savedB.account.alias, 'alt1');

    // Duplicate alias collision throws unless --force.
    assert.throws(
      () => saveCurrentAccount({ alias: 'work', baseDir, home, keyring, now: 2500 }),
      /already assigned to another account/,
    );

    // Switch B -> A.
    const swToA = switchToAccount('work', { baseDir, home, keyring, now: 3000 });
    assert.equal(swToA.account.alias, 'work');
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokA1);

    // Simulate hourly background agy refresh on A (same refresh_token, new access_token).
    writeActiveAgyCredential(tokA2, { home, keyring });

    // Switch A -> B: must write back A's refreshed token before swapping to B!
    const swToB = switchToAccount('alt1', { baseDir, home, keyring, now: 4000 });
    assert.equal(swToB.fromAlias, 'work');
    assert.equal(swToB.wroteBackOutgoing, true);
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokB1);

    // Switch back B -> A: must restore A's REFRESHED token (tokA2), not stale tokA1!
    switchToAccount('work', { baseDir, home, keyring, now: 5000 });
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokA2);

    // Atomic rollback if writing active credential fails during switch.
    const flakyKeyring = {
      ...keyring,
      set(service, account, secret, opts) {
        if (service === 'gemini' && secret === tokB1) {
          throw new Error('simulated keychain lock error');
        }
        return keyring.set(service, account, secret, opts);
      },
    };
    assert.throws(
      () => switchToAccount('alt1', { baseDir, home, keyring: flakyKeyring, now: 5500 }),
      /Failed to activate account "alt1"/,
    );
    // Outgoing credential (tokA2) must still be intact after rollback!
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokA2);

    // Rename and remove.
    const ren = renameAccount('alt1', 'backup-pro', { baseDir, now: 6000 });
    assert.equal(ren.oldAlias, 'alt1');
    assert.equal(ren.newAlias, 'backup-pro');

    const rem = removeAccount('backup-pro', { baseDir, keyring, now: 7000 });
    assert.equal(rem.removed, true);
    assert.equal(rem.remaining, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('multi-terminal drift guard repairs background refresh overwrite without clobbering untracked logins', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-drift-home-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  try {
    // 1) Zero-touch fast path when multi-account is never configured.
    let keyringTouched = false;
    const guardKeyring = {
      isAvailable: () => {
        keyringTouched = true;
        return true;
      },
    };
    const unused = syncActiveAccountBeforeLaunch({ baseDir, home, keyring: guardKeyring });
    assert.equal(unused.active, false);
    assert.equal(unused.reason, 'unused');
    assert.equal(keyringTouched, false);

    // 2) Configure two accounts: work (A) and alt1 (B), with B active.
    const keyring = createMemoryKeyring();
    const tokA1 = makeFakeToken({ email: 'a@example.com', sub: 'sub-a', access: 'a1', refresh: 'ref-a' });
    const tokA2 = makeFakeToken({ email: 'a@example.com', sub: 'sub-a', access: 'a2-bg-refresh', refresh: 'ref-a' });
    const tokB1 = makeFakeToken({ email: 'b@example.com', sub: 'sub-b', access: 'b1', refresh: 'ref-b' });
    const tokUnknown = makeFakeToken({ email: 'new@example.com', sub: 'sub-new', access: 'n1', refresh: 'ref-new' });

    writeActiveAgyCredential(tokA1, { home, keyring });
    saveCurrentAccount({ alias: 'work', baseDir, home, keyring, now: 1000 });
    writeActiveAgyCredential(tokB1, { home, keyring });
    saveCurrentAccount({ alias: 'alt1', baseDir, home, keyring, now: 2000 });

    // Background old agy terminal running Account A refreshes and overwrites active credential with tokA2!
    writeActiveAgyCredential(tokA2, { home, keyring });

    const repaired = syncActiveAccountBeforeLaunch({ baseDir, home, keyring, now: 3000 });
    assert.equal(repaired.synced, true);
    assert.equal(repaired.repairedFrom, 'work');
    assert.equal(repaired.alias, 'alt1');
    // Active credential is restored back to alt1 (tokB1)...
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokB1);
    // ...AND Account A's refreshed tokA2 was safely preserved in vault!
    switchToAccount('work', { baseDir, home, keyring, now: 4000 });
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokA2);

    // 3) If user logs into a brand-new untracked account manually, drift guard must NOT clobber it!
    writeActiveAgyCredential(tokUnknown, { home, keyring });
    const untouched = syncActiveAccountBeforeLaunch({ baseDir, home, keyring, now: 5000 });
    assert.equal(untouched.synced, false);
    assert.equal(untouched.reason, 'untracked-login');
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokUnknown);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('headless file-vault fallback (0600), stale lock recovery, prepare/restore login, and AES-256-GCM backup/restore', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-vault-home-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  const home2 = mkdtempSync(join(tmpdir(), 'agy-bar-vault-home2-'));
  const baseDir2 = join(home2, '.gemini', 'config', 'agy-bar');
  try {
    const noKeyring = createMemoryKeyring({}, { available: false });
    const tok1 = makeFakeToken({ email: 'headless@example.com', sub: 'sub-h', access: 'h-acc', refresh: 'h-ref' });
    writeActiveAgyCredential(tok1, { home, keyring: noKeyring });

    // Plant a stale lockfile with a dead PID and old timestamp to verify automatic recovery.
    mkdirSync(accountsDir(baseDir), { recursive: true });
    writeFileSync(
      accountLockPath(baseDir),
      JSON.stringify({ pid: 999999, host: 'stale-host', createdAt: Date.now() - 60_000 }) + '\n',
      'utf8',
    );

    const saved = saveCurrentAccount({ alias: 'ssh-box', baseDir, home, keyring: noKeyring, now: 1000 });
    assert.equal(saved.account.storageBackend, 'file');
    const vaultPath = accountVaultFilePath(baseDir);
    assert.equal(existsSync(vaultPath), true);
    if (process.platform !== 'win32') {
      assert.equal(statSync(vaultPath).mode & 0o777, 0o600);
    }

    // Prepare for new login preserves current & clears active; restore puts it back if user cancels.
    const { preserved } = prepareForNewAccountLogin({ baseDir, home, keyring: noKeyring, now: 2000 });
    assert.equal(preserved.alias, 'ssh-box');
    assert.equal(readActiveAgyCredential({ home, keyring: noKeyring }), null);
    assert.equal(restorePreservedLogin(preserved, { home, keyring: noKeyring }), true);
    assert.equal(readActiveAgyCredential({ home, keyring: noKeyring }).raw, tok1);

    // AES-256-GCM encrypted backup & restore onto a new machine with OS keyring.
    const envelope = exportEncryptedBackup({ passphrase: 'correct-horse-battery', baseDir, keyring: noKeyring, now: 3000 });
    assert.equal(envelope.format, 'agy-bar-vault-backup');
    assert.equal(envelope.cipher, 'aes-256-gcm');
    assert.equal(envelope.count, 1);
    const envelopeStr = JSON.stringify(envelope);
    assert.ok(!envelopeStr.includes('h-acc'));
    assert.ok(!envelopeStr.includes('h-ref'));
    assert.ok(!envelopeStr.includes('headless@example.com'));

    const targetKeyring = createMemoryKeyring();
    assert.throws(
      () => importEncryptedBackup(envelope, { passphrase: 'wrong-passphrase', baseDir: baseDir2, keyring: targetKeyring }),
      /Failed to decrypt backup/,
    );

    const restored = importEncryptedBackup(envelope, {
      passphrase: 'correct-horse-battery',
      baseDir: baseDir2,
      keyring: targetKeyring,
      now: 4000,
    });
    assert.deepEqual(restored.imported, ['ssh-box']);
    assert.equal(restored.total, 1);

    switchToAccount('ssh-box', { baseDir: baseDir2, home: home2, keyring: targetKeyring, now: 5000 });
    assert.equal(readActiveAgyCredential({ home: home2, keyring: targetKeyring }).raw, tok1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });
  }
});

test('multi-account passive quota isolation, reset-due READY promotion, smart next selector, and zero-secret JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-acct-quota-'));
  const baseDir = join(home, '.gemini', 'config', 'agy-bar');
  try {
    const keyring = createMemoryKeyring();
    const now = Date.parse('2026-11-27T10:00:00Z');

    const tokA = makeFakeToken({ email: 'alice@example.com', sub: 'sub-a', access: 'secret-a', refresh: 'ref-a' });
    const tokB = makeFakeToken({ email: 'bob@example.com', sub: 'sub-b', access: 'secret-b', refresh: 'ref-b' });
    const tokC = makeFakeToken({ email: 'carol@example.com', sub: 'sub-c', access: 'secret-c', refresh: 'ref-c' });

    writeActiveAgyCredential(tokA, { home, keyring });
    const a = saveCurrentAccount({ alias: 'work', baseDir, home, keyring, now: now - 30_000 }).account;
    writeActiveAgyCredential(tokB, { home, keyring });
    const b = saveCurrentAccount({ alias: 'alt1', baseDir, home, keyring, now: now - 20_000 }).account;
    writeActiveAgyCredential(tokC, { home, keyring });
    const c = saveCurrentAccount({ alias: 'alt2', baseDir, home, keyring, now: now - 10_000 }).account;

    // Populate passive quota cache for all 3 accounts without clobbering each other.
    syncSharedQuota(
      {
        'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T12:30:00Z' },
        'gemini-weekly': { remaining_fraction: 0.7, reset_time: '2026-12-03T10:00:00Z' },
        '3p-5h': { remaining_fraction: 0.12, reset_time: '2026-11-27T13:00:00Z' },
        '3p-weekly': { remaining_fraction: 0.5, reset_time: '2026-12-03T10:00:00Z' },
      },
      { baseDir, now: now - 5_000, accountKey: hashAccountIdentifier('alice@example.com') },
    );

    // Account B's 5h hit 0% earlier, but reset_time (09:30Z) has PASSED and weekly is 80% -> READY (100% reset due)!
    syncSharedQuota(
      {
        'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T09:30:00Z' },
        'gemini-weekly': { remaining_fraction: 0.8, reset_time: '2026-12-03T10:00:00Z' },
        '3p-5h': { remaining_fraction: 0.9, reset_time: '2026-11-27T14:00:00Z' },
        '3p-weekly': { remaining_fraction: 0.95, reset_time: '2026-12-03T10:00:00Z' },
      },
      { baseDir, now: now - 5_000, accountKey: hashAccountIdentifier('bob@example.com') },
    );

    // Account C's 5h reset time passed, BUT weekly is 0% (still active until Dec 3) -> stays LIMITED!
    syncSharedQuota(
      {
        'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T09:00:00Z' },
        'gemini-weekly': { remaining_fraction: 0, reset_time: '2026-12-03T10:00:00Z' },
        '3p-5h': { remaining_fraction: 0.45, reset_time: '2026-11-27T14:00:00Z' },
        '3p-weekly': { remaining_fraction: 0.4, reset_time: '2026-12-03T10:00:00Z' },
      },
      { baseDir, now: now - 5_000, accountKey: hashAccountIdentifier('carol@example.com') },
    );

    const allQuotas = readAllAccountQuotas({ baseDir, now });
    assert.equal(Object.keys(allQuotas).length, 3);

    const rows = listAccountsWithQuota({ baseDir, now });
    const rowA = rows.find((r) => r.id === a.id);
    const rowB = rows.find((r) => r.id === b.id);
    const rowC = rows.find((r) => r.id === c.id);

    assert.equal(rowA.gemini.status, 'LIMITED');
    assert.equal(rowA.gemini.nextResetLabel, '2h30m');
    assert.equal(rowA.claude.status, 'LOW');

    assert.equal(rowB.gemini.status, 'READY');
    assert.equal(rowB.gemini.fiveHourPct, 100);
    assert.equal(rowB.gemini.resetDue, true);

    assert.equal(rowC.gemini.status, 'LIMITED');
    assert.equal(rowC.claude.status, 'READY');

    // Pick next best for Gemini while on work -> alt1 (100% READY).
    const pickGemini = pickNextBestAccount(rows, { currentId: a.id, family: 'gemini' });
    assert.equal(pickGemini.account.alias, 'alt1');
    assert.equal(pickGemini.allLimited, false);

    // Pick next best for Claude while on alt1 -> alt2 (45% READY beats work's 12% LOW).
    const pickClaude = pickNextBestAccount(rows, { currentId: b.id, family: 'claude' });
    assert.equal(pickClaude.account.alias, 'alt2');

    // JSON projection must strictly omit all token fields and raw emails.
    const jsonText = JSON.stringify(rows.map(sanitizeAccountForJson));
    assert.ok(!jsonText.includes('secret-a'));
    assert.ok(!jsonText.includes('ref-a'));
    assert.ok(!jsonText.includes('alice@example.com'));
    assert.ok(jsonText.includes('al***@example.com'));

    // Formatted table renders cleanly in plain mode.
    const table = formatAccountTable(rows, { color: false, now });
    assert.ok(table.includes('work'));
    assert.ok(table.includes('alt1'));
    assert.ok(table.includes('READY'));
    assert.ok(table.includes('LOW'));
    assert.ok(table.includes('↻2h30m'));

    // When all accounts are LIMITED, pickNextBestAccount picks earliest reset and table shows LIMITED.
    const allLimitedRows = [
      {
        ...rowA,
        overallStatus: 'LIMITED',
        gemini: { ...rowA.gemini, status: 'LIMITED', nextResetTs: now + 90 * 60_000, nextResetLabel: '1h30m' },
        claude: { ...rowA.claude, status: 'LIMITED', fiveHourPct: 0, nextResetTs: now + 90 * 60_000, nextResetLabel: '1h30m' },
      },
      {
        ...rowB,
        overallStatus: 'LIMITED',
        gemini: { ...rowB.gemini, status: 'LIMITED', fiveHourPct: 0, nextResetTs: now + 30 * 60_000, nextResetLabel: '30m' },
        claude: { ...rowB.claude, status: 'LIMITED', fiveHourPct: 0, nextResetTs: now + 30 * 60_000, nextResetLabel: '30m' },
      },
    ];
    const soonest = pickNextBestAccount(allLimitedRows, { currentId: null, family: 'auto' });
    assert.equal(soonest.allLimited, true);
    assert.equal(soonest.account.alias, 'alt1');
    assert.ok(formatAccountTable(allLimitedRows, { color: false, now }).includes('LIMITED'));

    // Direct helper sanity checks.
    assert.equal(maskEmail('a@b.io'), '***@b.io');
    assert.equal(maskEmail('ab@b.io'), 'a***@b.io');
    assert.equal(parseAgyTokenPayload(tokA).hasRefreshToken, true);
    assert.equal(evaluateFamilyQuota(null, 'gemini-5h', 'gemini-weekly', now).status, 'UNKNOWN');

    // Statusline SWAP hint triggers when active account is LIMITED on active model family and hides when READY.
    switchToAccount('work', { baseDir, home, keyring, now });
    const limitedPayload = {
      model: { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon' },
      terminal_width: 130,
      quota: {
        'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-27T12:30:00Z' },
        'gemini-weekly': { remaining_fraction: 0.7, reset_time: '2026-12-03T10:00:00Z' },
      },
    };
    const hint = computeSwapHint({ payload: limitedPayload, activeAccountId: a.id, baseDir, now });
    assert.equal(hint?.alias, 'alt1');
    assert.equal(hint?.family, 'gemini');
    const renderedWithHint = renderStatusline(limitedPayload, { color: false, now, swapHint: hint });
    assert.ok(renderedWithHint.includes('SWAP→alt1'));

    const healthyPayload = {
      ...limitedPayload,
      quota: { 'gemini-5h': { remaining_fraction: 0.85, reset_time: '2026-11-27T12:30:00Z' } },
    };
    assert.equal(computeSwapHint({ payload: healthyPayload, activeAccountId: a.id, baseDir, now }), null);

    // Pre-launch / post-exit maybeAutoSwitchAccount switches away from LIMITED work -> READY alt1.
    const autoSw = maybeAutoSwitchAccount({ family: 'gemini', baseDir, home, keyring, now });
    assert.equal(autoSw.switched, true);
    assert.equal(autoSw.fromAlias, 'work');
    assert.equal(autoSw.toAlias, 'alt1');
    assert.equal(readActiveAgyCredential({ home, keyring }).raw, tokB);
    // Calling again while on READY alt1 is a clean no-op.
    const noOp = maybeAutoSwitchAccount({ family: 'gemini', baseDir, home, keyring, now });
    assert.equal(noOp.switched, false);
    assert.equal(noOp.reason, 'not-limited');

    // Config toggles swapHint, autoSwitchOnLimit, and autoHandoff cleanly.
    const cfgPath = join(baseDir, 'config.json');
    applyConfigCommand(['set', 'swapHint', 'off', 'autoSwitchOnLimit', 'on', 'autoHandoff', 'on'], cfgPath);
    const loadedCfg = loadConfig(cfgPath);
    assert.equal(loadedCfg.swapHint, false);
    assert.equal(loadedCfg.autoSwitchOnLimit, true);
    assert.equal(loadedCfg.autoHandoff, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

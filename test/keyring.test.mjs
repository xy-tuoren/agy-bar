import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AGY_KEYRING_ACCOUNT,
  AGY_KEYRING_SERVICE,
  agyFallbackTokenPath,
  assertSafeCredentialIdentifier,
  buildMacAddGenericPasswordLine,
  buildWindowsCredScript,
  clearActiveAgyCredential,
  compactWindowsCredentialPayload,
  createKeyringBackend,
  createMemoryKeyring,
  decodeSecurityHexIfNeeded,
  decodeWindowsSecretBuffer,
  readActiveAgyCredential,
  VAULT_KEYRING_SERVICE,
  WINDOWS_CRED_BLOB_LIMIT,
  writeActiveAgyCredential,
} from '../src/keyring.mjs';

test('macOS keyring adapter uses stdin (-i -X hex), preserves ACL on update, and decodes hex output', () => {
  const calls = [];
  let stored = null;

  const execFn = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    assert.equal(cmd, '/usr/bin/security');
    // Secret material must never appear in process argv.
    assert.ok(!args.join(' ').includes('secret-access-token'));

    if (args[0] === 'find-generic-password' && !args.includes('-w')) {
      return stored !== null
        ? { status: 0, stdout: '', stderr: '', error: null }
        : { status: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.', error: null };
    }
    if (args[0] === 'find-generic-password' && args.includes('-w')) {
      if (stored === null) {
        return { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.', error: null };
      }
      // Simulate macOS hex-encoding output when payload contains newline.
      const out = stored.includes('\n') ? Buffer.from(stored, 'utf8').toString('hex') : stored;
      return { status: 0, stdout: `${out}\n`, stderr: '', error: null };
    }
    if (args[0] === '-i') {
      const m = /-X\s+([0-9a-f]+)/i.exec(opts.input || '');
      assert.ok(m, 'expected hex secret via stdin');
      stored = Buffer.from(m[1], 'hex').toString('utf8');
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    if (args[0] === 'delete-generic-password') {
      if (stored === null) {
        return { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.', error: null };
      }
      stored = null;
      return { status: 0, stdout: '', stderr: '', error: null };
    }
    throw new Error(`Unexpected security invocation: ${args.join(' ')}`);
  };

  const mac = createKeyringBackend({ platform: 'darwin', execFn });
  assert.equal(mac.kind, 'macos-keychain');
  assert.equal(mac.exists(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), false);
  assert.equal(mac.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), null);

  // First create on shared active AGY slot passes -A and omits -U.
  const payload1 = JSON.stringify({ token: { access_token: 'secret-access-token-1' } });
  mac.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, payload1, { sharedAcl: true });
  const createCall = calls.find((c) => c.args[0] === '-i');
  assert.ok(createCall.input.includes(' -A '));
  assert.ok(!createCall.input.includes(' -U '));
  assert.equal(mac.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), payload1);

  // Subsequent update passes -U and omits -A so macOS preserves existing ACL without re-prompting.
  const payload2 = `${JSON.stringify({ token: { access_token: 'secret-access-token-2' } })}\n`;
  mac.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, payload2, { sharedAcl: true });
  const updateCall = calls.filter((c) => c.args[0] === '-i').at(-1);
  assert.ok(updateCall.input.includes(' -U '));
  assert.ok(!updateCall.input.includes(' -A '));
  assert.equal(mac.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), payload2);

  // Vault slot (sharedAcl: false) never sets -A even on initial creation.
  const vaultLine = buildMacAddGenericPasswordLine({
    service: VAULT_KEYRING_SERVICE,
    account: 'acct-1234',
    secret: '{"ok":true}',
    update: false,
    sharedAcl: false,
  });
  assert.ok(!vaultLine.includes(' -A '));
  assert.ok(!vaultLine.includes(' -U '));

  assert.equal(mac.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), true);
  assert.equal(mac.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), false);

  // Identifier validation blocks shell/command injection.
  assert.throws(() => assertSafeCredentialIdentifier('bad; rm -rf /'), /Invalid keyring/);
  assert.throws(() => assertSafeCredentialIdentifier('has space'), /Invalid keyring/);

  // Hex helper leaves non-hex raw JSON untouched and decodes hex-encoded JSON.
  const rawJson = '{"token":{"access_token":"abc"}}';
  assert.equal(decodeSecurityHexIfNeeded(rawJson), rawJson);
  assert.equal(decodeSecurityHexIfNeeded(Buffer.from(rawJson, 'utf8').toString('hex')), rawJson);
});

test('Linux secret-tool adapter passes secret over stdin and degrades cleanly on headless D-Bus', () => {
  const store = new Map();
  const linux = createKeyringBackend({
    platform: 'linux',
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    execFn: (cmd, args, opts = {}) => {
      assert.equal(cmd, 'secret-tool');
      assert.ok(!args.join(' ').includes('linux-secret'));
      if (args[0] === '--version') return { status: 0, stdout: 'secret-tool 0.21', stderr: '', error: null };
      const sIdx = args.indexOf('service');
      const uIdx = args.indexOf('username');
      const key = `${args[sIdx + 1]}:${args[uIdx + 1]}`;
      if (args[0] === 'store') {
        store.set(key, opts.input);
        return { status: 0, stdout: '', stderr: '', error: null };
      }
      if (args[0] === 'lookup') {
        return store.has(key)
          ? { status: 0, stdout: `${store.get(key)}\n`, stderr: '', error: null }
          : { status: 1, stdout: '', stderr: '', error: null };
      }
      if (args[0] === 'clear') {
        const had = store.delete(key);
        return { status: had ? 0 : 1, stdout: '', stderr: '', error: null };
      }
      throw new Error(`Unexpected secret-tool call: ${args.join(' ')}`);
    },
  });

  assert.equal(linux.kind, 'linux-secret-service');
  assert.equal(linux.isAvailable(), true);
  assert.equal(linux.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), null);
  linux.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, '{"access_token":"linux-secret"}');
  assert.equal(linux.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), '{"access_token":"linux-secret"}');
  assert.equal(linux.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), true);
  assert.equal(linux.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), null);

  // Headless Linux without D-Bus falls back gracefully.
  const headless = createKeyringBackend({
    platform: 'linux',
    env: {},
    execFn: (cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'secret-tool 0.21', stderr: '', error: null };
      return {
        status: 1,
        stdout: '',
        stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY',
        error: null,
      };
    },
  });
  assert.equal(headless.isAvailable(), false);
  assert.throws(
    () => headless.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, '{}'),
    (err) => err.code === 'KEYRING_UNAVAILABLE',
  );
});

test('Windows Credential Manager adapter uses stdin JSON, handles Win32 1168, and decodes UTF-8/UTF-16LE', () => {
  const creds = new Map();
  const win = createKeyringBackend({
    platform: 'win32',
    execFn: (cmd, args, opts = {}) => {
      assert.equal(cmd, 'powershell.exe');
      assert.ok(args.includes('-EncodedCommand'));
      assert.ok(!args.join(' ').includes('win-secret'));

      const req = JSON.parse(opts.input);
      if (req.op === 'set') {
        creds.set(req.target, Buffer.from(req.secretB64, 'base64'));
        return { status: 0, stdout: JSON.stringify({ ok: true }) + '\n', stderr: '', error: null };
      }
      if (req.op === 'exists') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, found: creds.has(req.target) }) + '\n',
          stderr: '',
          error: null,
        };
      }
      if (req.op === 'get') {
        if (!creds.has(req.target)) {
          return { status: 0, stdout: JSON.stringify({ ok: true, found: false }) + '\n', stderr: '', error: null };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, found: true, secretB64: creds.get(req.target).toString('base64') }) + '\n',
          stderr: '',
          error: null,
        };
      }
      if (req.op === 'delete') {
        const deleted = creds.delete(req.target);
        return { status: 0, stdout: JSON.stringify({ ok: true, deleted }) + '\n', stderr: '', error: null };
      }
      throw new Error(`Unexpected win op: ${req.op}`);
    },
  });

  assert.equal(win.kind, 'windows-credman');
  assert.equal(win.exists(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), false);
  assert.equal(win.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), null);

  win.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, '{"access_token":"win-secret"}');
  assert.ok(creds.has('gemini:antigravity'));
  assert.equal(win.exists(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), true);
  assert.equal(win.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), '{"access_token":"win-secret"}');

  // Verify UTF-16LE buffer compatibility as well as UTF-8.
  assert.equal(decodeWindowsSecretBuffer(Buffer.from('{"a":1}', 'utf8')), '{"a":1}');
  assert.equal(decodeWindowsSecretBuffer(Buffer.from('{"a":1}', 'utf16le')), '{"a":1}');

  assert.equal(win.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), true);
  assert.equal(win.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT), false);

  // Verify UTF-8 console encoding & CRED_PERSIST_ENTERPRISE = 3 in generated PowerShell script.
  const psScript = buildWindowsCredScript();
  assert.ok(psScript.includes('[Console]::InputEncoding = [System.Text.Encoding]::UTF8'));
  assert.ok(psScript.includes('CRED_PERSIST_ENTERPRISE = 3'));

  // Verify 2560-byte compaction (base64 unwrap, duplicate nested id_token dedup, oversized id_token trim, hard fallback).
  const dupToken = JSON.stringify({
    token: { access_token: 'a1', refresh_token: 'r1', id_token: 'eyJ.small.sig' },
    auth_method: 'consumer',
    id_token: 'eyJ.small.sig',
  });
  const wrappedB64 = `go-keyring-base64:${Buffer.from(dupToken, 'utf8').toString('base64')}`;
  const compacted = compactWindowsCredentialPayload(wrappedB64);
  assert.equal(compacted.fits, true);
  assert.equal(compacted.trimmedIdToken, false);
  const parsedCompact = JSON.parse(compacted.value);
  assert.equal(parsedCompact.id_token, 'eyJ.small.sig');
  assert.equal(parsedCompact.token.id_token, undefined);

  const hugeJwtPayload = JSON.stringify({
    token: { access_token: 'a1', refresh_token: 'r1' },
    id_token: 'x'.repeat(2700),
  });
  const trimmedJwt = compactWindowsCredentialPayload(hugeJwtPayload);
  assert.equal(trimmedJwt.fits, true);
  assert.equal(trimmedJwt.trimmedIdToken, true);
  assert.ok(trimmedJwt.byteLength <= WINDOWS_CRED_BLOB_LIMIT);

  const trulyHuge = JSON.stringify({ token: { access_token: 'a'.repeat(3000), refresh_token: 'r1' } });
  assert.throws(
    () => win.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, trulyHuge),
    (err) => err.code === 'KEYRING_UNAVAILABLE',
  );

  // Win32 error 1312 (ERROR_NO_SUCH_LOGON_SESSION under OpenSSH) degrades gracefully to KEYRING_UNAVAILABLE.
  const winSsh = createKeyringBackend({
    platform: 'win32',
    execFn: () => ({ status: 1, stdout: JSON.stringify({ ok: false, code: 1312 }) + '\n', stderr: '', error: null }),
  });
  assert.throws(
    () => winSsh.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT),
    (err) => err.code === 'KEYRING_UNAVAILABLE',
  );
  assert.equal(winSsh.isAvailable(), false);
});

test('read/write/clearActiveAgyCredential syncs keyring and 0600 fallback file across available and headless modes', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-bar-cred-home-'));
  try {
    const keyring = createMemoryKeyring();
    const secret = JSON.stringify({ token: { access_token: 'tok-1', refresh_token: 'ref-1' } });

    const writeRes = writeActiveAgyCredential(secret, { home, keyring });
    assert.equal(writeRes.wroteKeyring, true);
    assert.equal(writeRes.wroteFile, true);

    const filePath = agyFallbackTokenPath(home);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, 'utf8').trim(), secret);
    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    }

    const readFromKeyring = readActiveAgyCredential({ home, keyring });
    assert.equal(readFromKeyring.source, 'keyring');
    assert.equal(readFromKeyring.raw, secret);

    // If keyring is unavailable (headless SSH), seamlessly reads from fallback file.
    const unavailable = createMemoryKeyring({}, { available: false });
    const readFromFile = readActiveAgyCredential({ home, keyring: unavailable });
    assert.equal(readFromFile.source, 'file');
    assert.equal(readFromFile.raw, secret);

    const clearRes = clearActiveAgyCredential({ home, keyring });
    assert.equal(clearRes.clearedKeyring, true);
    assert.equal(clearRes.clearedFile, true);
    assert.equal(readActiveAgyCredential({ home, keyring }), null);
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

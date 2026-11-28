import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-atomic.mjs';

export const AGY_KEYRING_SERVICE = 'gemini';
export const AGY_KEYRING_ACCOUNT = 'antigravity';
export const VAULT_KEYRING_SERVICE = 'agy-bar-account';
export const AGY_FALLBACK_TOKEN_FILENAME = 'jetski-standalone-oauth-token';
export const WINDOWS_CRED_BLOB_LIMIT = 2560;

const SAFE_IDENT_RE = /^[a-zA-Z0-9._:@/-]{1,128}$/;

export function agyFallbackTokenPath(home = homedir()) {
  return join(home, '.gemini', AGY_FALLBACK_TOKEN_FILENAME);
}

export function assertSafeCredentialIdentifier(value, label = 'identifier') {
  const s = String(value ?? '').trim();
  if (!SAFE_IDENT_RE.test(s)) {
    throw new Error(`Invalid keyring ${label}: must match ${SAFE_IDENT_RE.source}`);
  }
  return s;
}

export function decodeSecurityHexIfNeeded(raw) {
  const str = String(raw ?? '').replace(/\r?\n$/, '');
  if (!str) return '';
  if (str.length >= 2 && str.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(str)) {
    try {
      const decoded = Buffer.from(str, 'hex').toString('utf8');
      // Only treat as hex-encoded if the decoded text looks like valid UTF-8 JSON or printable text
      // (macOS `security -w` hex-encodes passwords containing newlines or non-ASCII bytes).
      const trimmed = decoded.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        JSON.parse(trimmed);
        return decoded;
      }
      if (!decoded.includes('\uFFFD') && /^[\t\r\n\x20-\x7e]+$/.test(decoded)) {
        return decoded;
      }
    } catch {
      // Keep original string if it was genuinely a hex token.
    }
  }
  return str;
}

export function buildMacAddGenericPasswordLine({ service, account, secret, update = false, sharedAcl = false }) {
  const safeService = assertSafeCredentialIdentifier(service, 'service');
  const safeAccount = assertSafeCredentialIdentifier(account, 'account');
  const hex = Buffer.from(String(secret ?? ''), 'utf8').toString('hex');
  const parts = ['add-generic-password'];
  if (update) {
    parts.push('-U');
  } else if (sharedAcl) {
    // Only pass -A on initial creation for shared active AGY slots so agy can read it without
    // prompting; updates (-U) intentionally omit -A to preserve existing Keychain ACLs.
    parts.push('-A');
  }
  parts.push('-a', safeAccount, '-s', safeService, '-X', hex);
  return `${parts.join(' ')}\n`;
}

export function compactWindowsCredentialPayload(rawSecret, { maxBytes = WINDOWS_CRED_BLOB_LIMIT } = {}) {
  let str = String(rawSecret ?? '').trim();
  const prefix = 'go-keyring-base64:';
  if (str.startsWith(prefix)) {
    try {
      str = Buffer.from(str.slice(prefix.length), 'base64').toString('utf8').trim();
    } catch {
      // Keep original string if malformed base64.
    }
  }

  let parsed = null;
  try {
    const candidate = JSON.parse(str);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate;
    }
  } catch {
    parsed = null;
  }

  if (!parsed) {
    const byteLength = Buffer.byteLength(str, 'utf8');
    return { value: str, byteLength, fits: byteLength <= maxBytes, trimmedIdToken: false };
  }

  // Promote nested token.id_token and drop duplicate to stay well under Windows' 2560-byte CredWriteW limit.
  const copy = { ...parsed };
  if (copy.token && typeof copy.token === 'object' && !Array.isArray(copy.token)) {
    const nested = { ...copy.token };
    if (typeof nested.id_token === 'string' && nested.id_token.trim()) {
      copy.id_token = nested.id_token.trim();
      delete nested.id_token;
    }
    copy.token = nested;
  }

  let compact = JSON.stringify(copy);
  let byteLength = Buffer.byteLength(compact, 'utf8');
  if (byteLength <= maxBytes) {
    return { value: compact, byteLength, fits: true, trimmedIdToken: false };
  }

  // If a huge enterprise JWT id_token still pushes the blob over 2560 bytes, drop optional id_token
  // for the Windows Credential Manager copy (mirror file & file vault retain the full payload).
  if (typeof copy.id_token === 'string' && copy.id_token.length > 0) {
    const withoutId = { ...copy };
    delete withoutId.id_token;
    const trimmed = JSON.stringify(withoutId);
    const trimmedBytes = Buffer.byteLength(trimmed, 'utf8');
    if (trimmedBytes <= maxBytes) {
      return { value: trimmed, byteLength: trimmedBytes, fits: true, trimmedIdToken: true };
    }
  }

  return { value: compact, byteLength, fits: false, trimmedIdToken: false };
}

export function buildWindowsCredScript() {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rawIn = [Console]::In.ReadToEnd()',
    'if (-not $rawIn) { throw "Missing stdin JSON payload" }',
    '$req = $rawIn | ConvertFrom-Json',
    '$code = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Runtime.InteropServices.ComTypes;',
    'public static class AgyBarWinCred {',
    '  public const uint CRED_TYPE_GENERIC = 1;',
    '  public const uint CRED_PERSIST_ENTERPRISE = 3;',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct CREDENTIAL {',
    '    public uint Flags;',
    '    public uint Type;',
    '    public string TargetName;',
    '    public string Comment;',
    '    public FILETIME LastWritten;',
    '    public uint CredentialBlobSize;',
    '    public IntPtr CredentialBlob;',
    '    public uint Persist;',
    '    public uint AttributeCount;',
    '    public IntPtr Attributes;',
    '    public string TargetAlias;',
    '    public string UserName;',
    '  }',
    '  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);',
    '  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredWrite([In] ref CREDENTIAL cred, uint flags);',
    '  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredDelete(string target, uint type, uint flags);',
    '  [DllImport("advapi32.dll", EntryPoint = "CredFree")]',
    '  public static extern void CredFree(IntPtr buffer);',
    '  public static byte[] ReadBytes(string target, out int err) {',
    '    err = 0;',
    '    IntPtr ptr;',
    '    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out ptr)) {',
    '      err = Marshal.GetLastWin32Error();',
    '      return null;',
    '    }',
    '    try {',
    '      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));',
    '      if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return new byte[0];',
    '      var bytes = new byte[cred.CredentialBlobSize];',
    '      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);',
    '      return bytes;',
    '    } finally {',
    '      CredFree(ptr);',
    '    }',
    '  }',
    '  public static int WriteBytes(string target, string userName, byte[] blob) {',
    '    IntPtr ptr = Marshal.AllocCoTaskMem(blob.Length);',
    '    try {',
    '      if (blob.Length > 0) Marshal.Copy(blob, 0, ptr, blob.Length);',
    '      var cred = new CREDENTIAL {',
    '        Type = CRED_TYPE_GENERIC,',
    '        TargetName = target,',
    '        UserName = userName,',
    '        CredentialBlobSize = (uint)blob.Length,',
    '        CredentialBlob = ptr,',
    '        Persist = CRED_PERSIST_ENTERPRISE',
    '      };',
    '      if (!CredWrite(ref cred, 0)) return Marshal.GetLastWin32Error();',
    '      return 0;',
    '    } finally {',
    '      Marshal.FreeCoTaskMem(ptr);',
    '    }',
    '  }',
    '  public static int DeleteTarget(string target) {',
    '    if (!CredDelete(target, CRED_TYPE_GENERIC, 0)) return Marshal.GetLastWin32Error();',
    '    return 0;',
    '  }',
    '}',
    '"@',
    'if (-not ("AgyBarWinCred" -as [type])) { Add-Type -TypeDefinition $code }',
    '$target = [string]$req.target',
    '$op = [string]$req.op',
    'if ($op -eq "get" -or $op -eq "exists") {',
    '  [int]$err = 0',
    '  $bytes = [AgyBarWinCred]::ReadBytes($target, [ref]$err)',
    '  if ($null -eq $bytes) {',
    '    if ($err -eq 1168) { @{ ok = $true; found = $false } | ConvertTo-Json -Compress; exit 0 }',
    '    @{ ok = $false; code = $err } | ConvertTo-Json -Compress; exit 1',
    '  }',
    '  if ($op -eq "exists") { @{ ok = $true; found = $true } | ConvertTo-Json -Compress; exit 0 }',
    '  $b64 = [Convert]::ToBase64String($bytes)',
    '  @{ ok = $true; found = $true; secretB64 = $b64 } | ConvertTo-Json -Compress',
    '} elseif ($op -eq "set") {',
    '  $bytes = [Convert]::FromBase64String([string]$req.secretB64)',
    '  $user = if ($req.user) { [string]$req.user } else { $target }',
    '  $err = [AgyBarWinCred]::WriteBytes($target, $user, $bytes)',
    '  if ($err -ne 0) { @{ ok = $false; code = $err } | ConvertTo-Json -Compress; exit 1 }',
    '  @{ ok = $true } | ConvertTo-Json -Compress',
    '} elseif ($op -eq "delete") {',
    '  $err = [AgyBarWinCred]::DeleteTarget($target)',
    '  if ($err -eq 1168 -or $err -eq 1312) { @{ ok = $true; deleted = $false } | ConvertTo-Json -Compress; exit 0 }',
    '  if ($err -ne 0) { @{ ok = $false; code = $err } | ConvertTo-Json -Compress; exit 1 }',
    '  @{ ok = $true; deleted = $true } | ConvertTo-Json -Compress',
    '} else {',
    '  @{ ok = $false; error = "unknown op" } | ConvertTo-Json -Compress; exit 2',
    '}',
  ].join('\n');
}

export function decodeWindowsSecretBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  // Detect UTF-16LE encoded ASCII/JSON (e.g. "{\0\"\0...") and decode gracefully; otherwise UTF-8.
  if (buf.length >= 4 && buf.length % 2 === 0 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString('utf16le').replace(/\0+$/, '');
  }
  return buf.toString('utf8');
}

function defaultExec(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 8000,
    input: options.input,
    env: options.env,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: typeof res.status === 'number' ? res.status : res.error ? 1 : 0,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    error: res.error || null,
  };
}

function isMacNotFound(res) {
  return (
    res.status === 44 ||
    /could not be found in the keychain/i.test(res.stderr) ||
    /errSecItemNotFound/i.test(res.stderr)
  );
}

function createMacKeyring({ execFn = defaultExec, env = process.env } = {}) {
  const bin = '/usr/bin/security';

  const exists = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const res = execFn(bin, ['find-generic-password', '-s', s, '-a', a], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    });
    if (res.error?.code === 'ENOENT') return false;
    if (res.status === 0) return true;
    if (isMacNotFound(res)) return false;
    throw new Error(`macOS Keychain lookup failed (code ${res.status}): ${res.stderr.trim() || 'unknown error'}`);
  };

  const get = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const res = execFn(bin, ['find-generic-password', '-s', s, '-a', a, '-w'], { env, timeout: 8000 });
    if (res.error) {
      throw new Error(`macOS Keychain unavailable: ${res.error.message}`);
    }
    if (res.status === 0) {
      return decodeSecurityHexIfNeeded(res.stdout);
    }
    if (isMacNotFound(res)) return null;
    throw new Error(`macOS Keychain read failed (code ${res.status}): ${res.stderr.trim() || 'access denied or locked'}`);
  };

  const set = (service, account, secret, { sharedAcl = false } = {}) => {
    const alreadyExists = exists(service, account);
    const stdinCmd = buildMacAddGenericPasswordLine({
      service,
      account,
      secret,
      update: alreadyExists,
      sharedAcl,
    });
    const res = execFn(bin, ['-i'], { input: stdinCmd, env, timeout: 8000 });
    if (res.error) {
      throw new Error(`macOS Keychain unavailable: ${res.error.message}`);
    }
    const errText = res.stderr.trim();
    if (res.status !== 0 || /security:\s+SecKeychain|execution error|User interaction is not allowed|denied/i.test(errText)) {
      throw new Error(`macOS Keychain write failed: ${errText || `exit ${res.status}`}`);
    }
  };

  const del = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const res = execFn(bin, ['delete-generic-password', '-s', s, '-a', a], { env, timeout: 5000 });
    if (res.error) {
      throw new Error(`macOS Keychain unavailable: ${res.error.message}`);
    }
    if (res.status === 0) return true;
    if (isMacNotFound(res)) return false;
    throw new Error(`macOS Keychain delete failed (code ${res.status}): ${res.stderr.trim() || 'unknown error'}`);
  };

  const probe = () => {
    if (execFn !== defaultExec) return true;
    return existsSync(bin);
  };

  return {
    kind: 'macos-keychain',
    label: 'macOS Keychain',
    isAvailable: probe,
    exists,
    get,
    set,
    delete: del,
  };
}

function isLinuxSecretServiceUnavailable(res) {
  if (res.error?.code === 'ENOENT') return true;
  const err = `${res.stderr} ${res.error?.message || ''}`;
  return /Cannot autolaunch D-Bus|org\.freedesktop\.secrets|No such interface|Failed to execute child process|GDBus\.Error|Could not connect|session bus/i.test(
    err,
  );
}

function createLinuxKeyring({ execFn = defaultExec, env = process.env } = {}) {
  let cachedAvailable = null;

  const isAvailable = () => {
    if (cachedAvailable !== null) return cachedAvailable;
    const res = execFn('secret-tool', ['--version'], { env, timeout: 3000 });
    if (res.error?.code === 'ENOENT') {
      cachedAvailable = false;
      return false;
    }
    // Headless SSH sessions without D-Bus session bus cannot reach Secret Service.
    if (!env?.DBUS_SESSION_BUS_ADDRESS && !env?.DISPLAY && !env?.WAYLAND_DISPLAY) {
      const probe = execFn('secret-tool', ['lookup', 'service', 'agy-bar-probe', 'username', 'probe'], {
        env,
        timeout: 3000,
      });
      if (isLinuxSecretServiceUnavailable(probe)) {
        cachedAvailable = false;
        return false;
      }
    }
    cachedAvailable = true;
    return true;
  };

  const get = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const res = execFn('secret-tool', ['lookup', 'service', s, 'username', a], { env, timeout: 5000 });
    if (isLinuxSecretServiceUnavailable(res)) {
      cachedAvailable = false;
      const err = new Error('Linux Secret Service (secret-tool / D-Bus) is unavailable');
      err.code = 'KEYRING_UNAVAILABLE';
      throw err;
    }
    if (res.status === 0) {
      return res.stdout.replace(/\r?\n$/, '');
    }
    if (res.status === 1 && !res.stderr.trim()) {
      return null;
    }
    throw new Error(`Linux secret-tool read failed (code ${res.status}): ${res.stderr.trim() || 'unknown error'}`);
  };

  const set = (service, account, secret) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const label = s === AGY_KEYRING_SERVICE ? 'Antigravity CLI' : `agy-bar (${a})`;
    const res = execFn('secret-tool', ['store', `--label=${label}`, 'service', s, 'username', a], {
      input: String(secret ?? ''),
      env,
      timeout: 8000,
    });
    if (isLinuxSecretServiceUnavailable(res)) {
      cachedAvailable = false;
      const err = new Error('Linux Secret Service (secret-tool / D-Bus) is unavailable');
      err.code = 'KEYRING_UNAVAILABLE';
      throw err;
    }
    if (res.status !== 0) {
      throw new Error(`Linux secret-tool write failed (code ${res.status}): ${res.stderr.trim() || 'unknown error'}`);
    }
  };

  const del = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    const res = execFn('secret-tool', ['clear', 'service', s, 'username', a], { env, timeout: 5000 });
    if (isLinuxSecretServiceUnavailable(res)) {
      cachedAvailable = false;
      const err = new Error('Linux Secret Service (secret-tool / D-Bus) is unavailable');
      err.code = 'KEYRING_UNAVAILABLE';
      throw err;
    }
    if (res.status === 0) return true;
    if (res.status === 1 && !res.stderr.trim()) return false;
    throw new Error(`Linux secret-tool delete failed (code ${res.status}): ${res.stderr.trim() || 'unknown error'}`);
  };

  const exists = (service, account) => get(service, account) !== null;

  return {
    kind: 'linux-secret-service',
    label: 'Linux Secret Service (secret-tool)',
    isAvailable,
    exists,
    get,
    set,
    delete: del,
  };
}

function createWindowsKeyring({ execFn = defaultExec, env = process.env } = {}) {
  const encodedScript = Buffer.from(buildWindowsCredScript(), 'utf16le').toString('base64');
  const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript];
  let cachedAvailable = null;

  const invoke = (payload) => {
    const res = execFn('powershell.exe', psArgs, {
      input: JSON.stringify(payload),
      env,
      timeout: 12_000,
    });
    if (res.error?.code === 'ENOENT') {
      cachedAvailable = false;
      const err = new Error('Windows PowerShell is unavailable for Credential Manager access');
      err.code = 'KEYRING_UNAVAILABLE';
      throw err;
    }
    const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
    let parsed = null;
    try {
      parsed = line ? JSON.parse(line) : null;
    } catch {
      parsed = null;
    }
    if (parsed && parsed.ok === true) {
      cachedAvailable = true;
      return parsed;
    }
    const winCode = Number(parsed?.code || 0);
    if (winCode === 1312) {
      // ERROR_NO_SUCH_LOGON_SESSION (e.g. headless Windows OpenSSH without interactive logon session).
      cachedAvailable = false;
      const err = new Error('Windows Credential Manager unavailable in this logon session (Win32 error 1312)');
      err.code = 'KEYRING_UNAVAILABLE';
      throw err;
    }
    const detail = parsed?.code
      ? `Win32 error ${parsed.code}`
      : parsed?.error || res.stderr.trim() || `exit ${res.status}`;
    throw new Error(`Windows Credential Manager ${payload.op} failed: ${detail}`);
  };

  const targetOf = (service, account) => {
    const s = assertSafeCredentialIdentifier(service, 'service');
    const a = assertSafeCredentialIdentifier(account, 'account');
    return `${s}:${a}`;
  };

  const isAvailable = () => {
    if (cachedAvailable !== null) return cachedAvailable;
    if (execFn !== defaultExec) return true;
    const probe = execFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { env, timeout: 4000 });
    cachedAvailable = !probe.error && probe.status === 0;
    return cachedAvailable;
  };

  return {
    kind: 'windows-credman',
    label: 'Windows Credential Manager',
    isAvailable,
    exists(service, account) {
      const out = invoke({ op: 'exists', target: targetOf(service, account) });
      return Boolean(out.found);
    },
    get(service, account) {
      const out = invoke({ op: 'get', target: targetOf(service, account) });
      if (!out.found) return null;
      return decodeWindowsSecretBuffer(Buffer.from(String(out.secretB64 || ''), 'base64'));
    },
    set(service, account, secret) {
      const a = assertSafeCredentialIdentifier(account, 'account');
      const compacted = compactWindowsCredentialPayload(secret);
      if (!compacted.fits) {
        const err = new Error(
          `Credential exceeds Windows Credential Manager ${WINDOWS_CRED_BLOB_LIMIT}-byte limit (${compacted.byteLength} bytes)`,
        );
        err.code = 'KEYRING_UNAVAILABLE';
        throw err;
      }
      invoke({
        op: 'set',
        target: targetOf(service, account),
        user: a,
        secretB64: Buffer.from(compacted.value, 'utf8').toString('base64'),
      });
    },
    delete(service, account) {
      const out = invoke({ op: 'delete', target: targetOf(service, account) });
      return Boolean(out.deleted);
    },
  };
}

export function createMemoryKeyring(initial = {}, { available = true, kind = 'memory' } = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(initial)) {
    if (typeof value === 'string') store.set(key, value);
  }
  const keyOf = (service, account) => `${service}\0${account}`;
  const ops = [];
  return {
    kind,
    label: `In-memory (${kind})`,
    ops,
    isAvailable: () => available,
    exists(service, account) {
      if (!available) {
        const err = new Error('Keyring unavailable');
        err.code = 'KEYRING_UNAVAILABLE';
        throw err;
      }
      return store.has(keyOf(service, account));
    },
    get(service, account) {
      if (!available) {
        const err = new Error('Keyring unavailable');
        err.code = 'KEYRING_UNAVAILABLE';
        throw err;
      }
      return store.has(keyOf(service, account)) ? store.get(keyOf(service, account)) : null;
    },
    set(service, account, secret, opts = {}) {
      if (!available) {
        const err = new Error('Keyring unavailable');
        err.code = 'KEYRING_UNAVAILABLE';
        throw err;
      }
      ops.push({ op: 'set', service, account, sharedAcl: Boolean(opts.sharedAcl) });
      store.set(keyOf(service, account), String(secret ?? ''));
    },
    delete(service, account) {
      if (!available) {
        const err = new Error('Keyring unavailable');
        err.code = 'KEYRING_UNAVAILABLE';
        throw err;
      }
      ops.push({ op: 'delete', service, account });
      return store.delete(keyOf(service, account));
    },
    dumpKeys() {
      return [...store.keys()];
    },
  };
}

export function createKeyringBackend({ platform = process.platform, env = process.env, execFn = defaultExec } = {}) {
  if (platform === 'darwin') return createMacKeyring({ execFn, env });
  if (platform === 'win32') return createWindowsKeyring({ execFn, env });
  if (platform === 'linux') return createLinuxKeyring({ execFn, env });
  return createMemoryKeyring({}, { available: false, kind: `unsupported-${platform}` });
}

export function readActiveAgyCredential({ home = homedir(), keyring = createKeyringBackend() } = {}) {
  let keyringError = null;
  if (keyring?.isAvailable?.()) {
    try {
      const fromKeyring = keyring.get(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT);
      if (typeof fromKeyring === 'string' && fromKeyring.trim()) {
        return { raw: fromKeyring.trim(), source: 'keyring', keyringKind: keyring.kind };
      }
    } catch (err) {
      keyringError = err;
    }
  }

  const fallbackPath = agyFallbackTokenPath(home);
  if (existsSync(fallbackPath)) {
    try {
      const fromFile = readFileSync(fallbackPath, 'utf8').trim();
      if (fromFile) {
        return { raw: fromFile, source: 'file', filePath: fallbackPath, keyringKind: keyring?.kind || 'none' };
      }
    } catch {
      // Ignore unreadable fallback file if keyring error is more informative.
    }
  }

  if (keyringError && keyringError.code !== 'KEYRING_UNAVAILABLE') {
    throw keyringError;
  }
  return null;
}

export function writeActiveAgyCredential(rawSecret, { home = homedir(), keyring = createKeyringBackend() } = {}) {
  const payload = String(rawSecret ?? '').trim();
  if (!payload) {
    throw new Error('Refusing to write an empty Antigravity credential.');
  }

  let wroteKeyring = false;
  let keyringWarning = null;
  if (keyring?.isAvailable?.()) {
    try {
      keyring.set(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, payload, { sharedAcl: true });
      wroteKeyring = true;
    } catch (err) {
      if (err?.code === 'KEYRING_UNAVAILABLE') {
        keyringWarning = err.message;
      } else {
        throw err;
      }
    }
  }

  const fallbackPath = agyFallbackTokenPath(home);
  writeFileAtomic(fallbackPath, `${payload}\n`, { mode: 0o600, dirMode: 0o700 });

  return {
    wroteKeyring,
    wroteFile: true,
    filePath: fallbackPath,
    keyringKind: keyring?.kind || 'none',
    keyringWarning,
  };
}

export function clearActiveAgyCredential({ home = homedir(), keyring = createKeyringBackend() } = {}) {
  let clearedKeyring = false;
  if (keyring?.isAvailable?.()) {
    try {
      clearedKeyring = Boolean(keyring.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT));
    } catch (err) {
      if (err?.code !== 'KEYRING_UNAVAILABLE') {
        throw err;
      }
    }
  }

  const fallbackPath = agyFallbackTokenPath(home);
  let clearedFile = false;
  if (existsSync(fallbackPath)) {
    rmSync(fallbackPath, { force: true });
    clearedFile = true;
  }

  return { clearedKeyring, clearedFile };
}

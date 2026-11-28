import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import {
  clearActiveAgyCredential,
  createKeyringBackend,
  readActiveAgyCredential,
  VAULT_KEYRING_SERVICE,
  writeActiveAgyCredential,
} from './keyring.mjs';
import { hashAccountIdentifier } from './quota-sync.mjs';

export const ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
export const VAULT_STORAGE_MODES = Object.freeze(['auto', 'keychain', 'file']);
export const DEFAULT_ACCOUNT_WEIGHT = 50;
export const MIN_ACCOUNT_WEIGHT = 0;
export const MAX_ACCOUNT_WEIGHT = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(WAIT_ARRAY, 0, 0, ms);
}

export function accountsDir(baseDir = configDir(homedir())) {
  return join(baseDir, 'accounts');
}

export function accountIndexPath(baseDir = configDir(homedir())) {
  return join(accountsDir(baseDir), 'index.json');
}

export function accountStatePath(baseDir = configDir(homedir())) {
  return join(accountsDir(baseDir), 'state.json');
}

export function accountVaultFilePath(baseDir = configDir(homedir())) {
  return join(accountsDir(baseDir), 'vault.json');
}

export function accountLockPath(baseDir = configDir(homedir())) {
  return join(accountsDir(baseDir), '.lock');
}

function sha256Short(value) {
  if (typeof value !== 'string' || !value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function maskEmail(email) {
  const cleaned = typeof email === 'string' ? email.trim() : '';
  const at = cleaned.indexOf('@');
  if (at <= 0 || at === cleaned.length - 1) return null;
  const local = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1);
  if (local.length <= 1) return `***@${domain}`;
  if (local.length === 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

export function decodeJwtClaimsUnsafe(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.trim().split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function decodeGoKeyringValue(raw) {
  const str = String(raw ?? '').trim();
  const prefix = 'go-keyring-base64:';
  if (str.startsWith(prefix)) {
    try {
      return Buffer.from(str.slice(prefix.length), 'base64').toString('utf8').trim();
    } catch {
      return str;
    }
  }
  return str;
}

export function parseAgyTokenPayload(raw) {
  const originalRaw = String(raw ?? '').trim();
  const str = decodeGoKeyringValue(originalRaw);
  if (!str) {
    throw new Error('Credential payload is empty.');
  }
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    throw new Error('Credential payload is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Credential payload must be a JSON object.');
  }

  const tokenObj = parsed.token && typeof parsed.token === 'object' ? parsed.token : parsed;
  const accessToken = typeof tokenObj.access_token === 'string' && tokenObj.access_token.trim() ? tokenObj.access_token.trim() : null;
  const refreshToken = typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token.trim() ? tokenObj.refresh_token.trim() : null;
  const idToken =
    (typeof parsed.id_token === 'string' && parsed.id_token.trim()) ||
    (typeof tokenObj.id_token === 'string' && tokenObj.id_token.trim()) ||
    null;

  if (!accessToken && !refreshToken && !idToken) {
    throw new Error('Credential JSON does not contain access_token, refresh_token, or id_token.');
  }

  const claims = idToken ? decodeJwtClaimsUnsafe(idToken) : null;
  const rawEmail =
    (typeof claims?.email === 'string' && claims.email.trim()) ||
    (typeof parsed.email === 'string' && parsed.email.trim()) ||
    null;
  const rawSub = (typeof claims?.sub === 'string' && claims.sub.trim()) || null;
  const rawExpiry = typeof tokenObj.expiry === 'string' ? tokenObj.expiry : null;
  const expiryMs = rawExpiry && Number.isFinite(Date.parse(rawExpiry)) ? Date.parse(rawExpiry) : null;

  return {
    raw: originalRaw,
    authMethod: typeof parsed.auth_method === 'string' ? parsed.auth_method : 'oauth',
    hasRefreshToken: Boolean(refreshToken),
    accessTokenHash: sha256Short(accessToken),
    refreshTokenHash: sha256Short(refreshToken),
    subHash: sha256Short(rawSub),
    emailHash: rawEmail ? hashAccountIdentifier(rawEmail) : null,
    maskedEmail: rawEmail ? maskEmail(rawEmail) : null,
    expiry: rawExpiry,
    expiryMs,
  };
}

export function validateAlias(alias) {
  const cleaned = String(alias ?? '').trim();
  if (!ALIAS_REGEX.test(cleaned)) {
    throw new Error(
      `Invalid account alias "${alias}". Use 1-32 alphanumeric characters, ".", "_", or "-" (starting with a letter or digit).`,
    );
  }
  return cleaned;
}

export function normalizeAccountWeight(value, { fallback = DEFAULT_ACCOUNT_WEIGHT, strict = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (strict) {
      throw new Error(
        `Weight must be an integer between ${MIN_ACCOUNT_WEIGHT} and ${MAX_ACCOUNT_WEIGHT} (higher = higher priority; 0 = manual only).`,
      );
    }
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_ACCOUNT_WEIGHT || n > MAX_ACCOUNT_WEIGHT) {
    if (strict) {
      throw new Error(
        `Invalid weight "${value}". Use an integer between ${MIN_ACCOUNT_WEIGHT} and ${MAX_ACCOUNT_WEIGHT} (higher = higher priority; 0 = manual only, excluded from auto-switch).`,
      );
    }
    return fallback;
  }
  return n;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function withAccountLock(fn, { baseDir = configDir(homedir()), timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const dir = accountsDir(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = accountLockPath(baseDir);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${Date.now()}:${randomBytes(4).toString('hex')}`;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token, createdAt: Date.now() }) + '\n');
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      // Inspect lock for staleness (dead PID or expired TTL).
      let stale = false;
      try {
        const raw = readFileSync(lockPath, 'utf8');
        const info = JSON.parse(raw);
        const age = Date.now() - Number(info?.createdAt || 0);
        if (age > LOCK_STALE_MS) {
          stale = true;
        } else if (info?.host === hostname() && Number.isInteger(info?.pid) && !isPidAlive(info.pid)) {
          stale = true;
        }
      } catch {
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
        } catch {
          // Lock vanished concurrently; retry immediately.
          continue;
        }
      }

      if (stale) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Ignore race.
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for agy-bar account lock (${lockPath}). Another account operation may be running.`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      const current = readFileSync(lockPath, 'utf8');
      if (current.includes(token)) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export function readAccountIndex({ baseDir = configDir(homedir()) } = {}) {
  const filePath = accountIndexPath(baseDir);
  if (!existsSync(filePath)) {
    return { version: 1, accounts: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
      return { version: 1, accounts: [] };
    }
    return { version: 1, accounts: parsed.accounts.filter((a) => a && typeof a === 'object' && typeof a.id === 'string') };
  } catch {
    return { version: 1, accounts: [] };
  }
}

function writeAccountIndex(index, { baseDir = configDir(homedir()) } = {}) {
  writeFileAtomic(accountIndexPath(baseDir), JSON.stringify({ version: 1, accounts: index.accounts }, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  });
}

export function readActiveAccountState({ baseDir = configDir(homedir()) } = {}) {
  const filePath = accountStatePath(baseDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      activeAccountId: typeof parsed.activeAccountId === 'string' ? parsed.activeAccountId : null,
      activeQuotaKey: typeof parsed.activeQuotaKey === 'string' ? parsed.activeQuotaKey : null,
      lastSwitchAt: typeof parsed.lastSwitchAt === 'number' ? parsed.lastSwitchAt : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeActiveAccountState(state, { baseDir = configDir(homedir()) } = {}) {
  writeFileAtomic(accountStatePath(baseDir), JSON.stringify({ version: 1, ...state }, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  });
}

function readFileVault(baseDir) {
  const filePath = accountVaultFilePath(baseDir);
  if (!existsSync(filePath)) return { version: 1, secrets: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.secrets || typeof parsed.secrets !== 'object') {
      return { version: 1, secrets: {} };
    }
    return { version: 1, secrets: { ...parsed.secrets } };
  } catch {
    return { version: 1, secrets: {} };
  }
}

function writeFileVault(vault, baseDir) {
  writeFileAtomic(accountVaultFilePath(baseDir), JSON.stringify({ version: 1, secrets: vault.secrets }, null, 2) + '\n', {
    mode: 0o600,
    dirMode: 0o700,
  });
}

function writeVaultSecret(slotId, rawSecret, { storage = 'auto', baseDir, keyring }) {
  if (!VAULT_STORAGE_MODES.includes(storage)) {
    throw new Error(`Invalid storage mode "${storage}". Choose one of: ${VAULT_STORAGE_MODES.join(', ')}`);
  }

  if (storage !== 'file' && keyring?.isAvailable?.()) {
    try {
      keyring.set(VAULT_KEYRING_SERVICE, slotId, rawSecret, { sharedAcl: false });
      // Remove any stale copy in file vault if migrating from file -> keychain.
      const vaultPath = accountVaultFilePath(baseDir);
      if (existsSync(vaultPath)) {
        const vault = readFileVault(baseDir);
        if (Object.hasOwn(vault.secrets, slotId)) {
          delete vault.secrets[slotId];
          writeFileVault(vault, baseDir);
        }
      }
      return 'keychain';
    } catch (err) {
      if (storage === 'keychain' || err?.code !== 'KEYRING_UNAVAILABLE') {
        throw err;
      }
    }
  } else if (storage === 'keychain') {
    throw new Error('OS keyring is not available in this environment. Use "--storage file" or default auto fallback.');
  }

  const vault = readFileVault(baseDir);
  vault.secrets[slotId] = rawSecret;
  writeFileVault(vault, baseDir);
  return 'file';
}

function readVaultSecret(slot, { baseDir, keyring }) {
  if (slot.storageBackend === 'keychain' && keyring?.isAvailable?.()) {
    try {
      const secret = keyring.get(VAULT_KEYRING_SERVICE, slot.id);
      if (typeof secret === 'string' && secret.trim()) return secret.trim();
    } catch (err) {
      if (err?.code !== 'KEYRING_UNAVAILABLE') throw err;
    }
  }

  const vault = readFileVault(baseDir);
  const fromFile = vault.secrets[slot.id];
  if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();

  // Last-chance check in keychain if metadata was stale.
  if (slot.storageBackend !== 'keychain' && keyring?.isAvailable?.()) {
    try {
      const secret = keyring.get(VAULT_KEYRING_SERVICE, slot.id);
      if (typeof secret === 'string' && secret.trim()) return secret.trim();
    } catch {
      // Ignore fallback miss.
    }
  }

  return null;
}

function deleteVaultSecret(slot, { baseDir, keyring }) {
  if (keyring?.isAvailable?.()) {
    try {
      keyring.delete(VAULT_KEYRING_SERVICE, slot.id);
    } catch {
      // Ignore if absent or unavailable.
    }
  }
  const vaultPath = accountVaultFilePath(baseDir);
  if (existsSync(vaultPath)) {
    const vault = readFileVault(baseDir);
    if (Object.hasOwn(vault.secrets, slot.id)) {
      delete vault.secrets[slot.id];
      writeFileVault(vault, baseDir);
    }
  }
}

export function matchSlotForToken(accounts, tokenInfo) {
  if (!Array.isArray(accounts) || !tokenInfo) return null;
  if (tokenInfo.refreshTokenHash) {
    const byRefresh = accounts.find((a) => a.refreshTokenHash && a.refreshTokenHash === tokenInfo.refreshTokenHash);
    if (byRefresh) return byRefresh;
  }
  if (tokenInfo.subHash) {
    const bySub = accounts.find((a) => a.subHash && a.subHash === tokenInfo.subHash);
    if (bySub) return bySub;
  }
  if (tokenInfo.emailHash) {
    const byEmail = accounts.find((a) => a.emailHash && a.emailHash === tokenInfo.emailHash);
    if (byEmail) return byEmail;
  }
  if (tokenInfo.accessTokenHash) {
    const byAccess = accounts.find((a) => a.accessTokenHash && a.accessTokenHash === tokenInfo.accessTokenHash);
    if (byAccess) return byAccess;
  }
  return null;
}

export function resolveAccountTarget(accounts, target) {
  const query = String(target ?? '').trim();
  if (!query) return null;
  const lower = query.toLowerCase();
  const exactAlias = accounts.find((a) => a.alias.toLowerCase() === lower);
  if (exactAlias) return exactAlias;
  const exactId = accounts.find((a) => a.id.toLowerCase() === lower);
  if (exactId) return exactId;
  const prefixMatches = accounts.filter((a) => a.id.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];
  return null;
}

function generateDefaultAlias(accounts) {
  const used = new Set(accounts.map((a) => a.alias.toLowerCase()));
  if (!used.has('primary')) return 'primary';
  for (let i = 1; i <= 999; i++) {
    const candidate = `acct-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `acct-${randomBytes(3).toString('hex')}`;
}

function createSlotId() {
  return `acct-${randomBytes(6).toString('hex')}`;
}

function upsertSlotRecord(
  index,
  { existing, alias, tokenInfo, storageBackend, tier = null, weight = undefined, maskedEmail = null, emailHash = null, now },
) {
  const id = existing?.id || createSlotId();
  const resolvedEmailHash = tokenInfo.emailHash || emailHash || existing?.emailHash || null;
  const quotaKey = resolvedEmailHash || existing?.quotaKey || id;
  const resolvedWeight =
    weight !== undefined && weight !== null
      ? normalizeAccountWeight(weight, { strict: true })
      : normalizeAccountWeight(existing?.weight, { fallback: DEFAULT_ACCOUNT_WEIGHT });
  const record = {
    id,
    alias,
    maskedEmail: tokenInfo.maskedEmail || maskedEmail || existing?.maskedEmail || null,
    emailHash: resolvedEmailHash,
    subHash: tokenInfo.subHash || existing?.subHash || null,
    quotaKey,
    tier: tier || existing?.tier || null,
    weight: resolvedWeight,
    authMethod: tokenInfo.authMethod || existing?.authMethod || 'oauth',
    hasRefreshToken: tokenInfo.hasRefreshToken,
    refreshTokenHash: tokenInfo.refreshTokenHash || existing?.refreshTokenHash || null,
    accessTokenHash: tokenInfo.accessTokenHash || existing?.accessTokenHash || null,
    expiry: tokenInfo.expiry || existing?.expiry || null,
    storageBackend,
    createdAt: existing?.createdAt || now,
    lastUsedAt: now,
    lastRefreshedAt: now,
  };

  if (existing) {
    const idx = index.accounts.findIndex((a) => a.id === existing.id);
    if (idx >= 0) index.accounts[idx] = record;
    else index.accounts.push(record);
  } else {
    index.accounts.push(record);
  }
  return record;
}

export function upsertImportedAccounts(
  candidates = [],
  {
    force = false,
    storage = 'auto',
    home = homedir(),
    baseDir = configDir(homedir()),
    keyring = createKeyringBackend(),
    now = Date.now(),
  } = {},
) {
  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      const imported = [];
      const updated = [];
      const skipped = [];

      for (const item of candidates) {
        if (!item?.rawSecret) {
          skipped.push({ alias: item?.alias || null, maskedEmail: item?.maskedEmail || null, reason: 'missing credential' });
          continue;
        }
        let tokenInfo;
        try {
          tokenInfo = parseAgyTokenPayload(item.rawSecret);
        } catch (err) {
          skipped.push({ alias: item?.alias || null, maskedEmail: item?.maskedEmail || null, reason: err.message });
          continue;
        }

        const effectiveEmailHash = tokenInfo.emailHash || item.emailHash || null;
        const matchInfo = { ...tokenInfo, emailHash: effectiveEmailHash };
        const existing = matchSlotForToken(index.accounts, matchInfo);

        let desiredAlias =
          item.alias && ALIAS_REGEX.test(String(item.alias))
            ? String(item.alias)
            : generateDefaultAlias(index.accounts);

        const collision = index.accounts.find((a) => a.alias.toLowerCase() === desiredAlias.toLowerCase());
        if (collision && (!existing || collision.id !== existing.id)) {
          if (force) {
            deleteVaultSecret(collision, { baseDir, keyring });
            index.accounts = index.accounts.filter((a) => a.id !== collision.id);
          } else {
            let suffix = 2;
            const stem = desiredAlias.slice(0, 28);
            while (index.accounts.some((a) => a.alias.toLowerCase() === `${stem}-${suffix}`.toLowerCase())) {
              suffix += 1;
            }
            desiredAlias = `${stem}-${suffix}`.slice(0, 32);
          }
        }

        const slotId = existing?.id || createSlotId();
        const actualStorage = writeVaultSecret(slotId, tokenInfo.raw, { storage, baseDir, keyring });
        const saved = upsertSlotRecord(index, {
          existing: existing ? { ...existing, id: slotId } : { id: slotId, createdAt: item.createdAt || now },
          alias: existing && !force ? existing.alias : desiredAlias,
          tokenInfo,
          storageBackend: actualStorage,
          tier: item.tier || null,
          maskedEmail: item.maskedEmail || null,
          emailHash: effectiveEmailHash,
          now: item.lastUsedAt || now,
        });

        const entry = {
          id: saved.id,
          alias: saved.alias,
          maskedEmail: saved.maskedEmail,
          quotaKey: saved.quotaKey,
          tier: saved.tier,
          storageBackend: saved.storageBackend,
          quotaBuckets: item.quotaBuckets || null,
        };
        if (existing) updated.push(entry);
        else imported.push(entry);
      }

      // If no active account is tracked yet, passively link whichever slot matches current agy login.
      let detectedActiveAlias = null;
      const existingState = readActiveAccountState({ baseDir });
      if (!existingState?.activeAccountId && index.accounts.length > 0) {
        try {
          const activeCred = readActiveAgyCredential({ home, keyring });
          if (activeCred?.raw) {
            const activeInfo = parseAgyTokenPayload(activeCred.raw);
            const matchedActive = matchSlotForToken(index.accounts, activeInfo);
            if (matchedActive) {
              matchedActive.lastUsedAt = now;
              writeActiveAccountState(
                {
                  activeAccountId: matchedActive.id,
                  activeQuotaKey: matchedActive.quotaKey,
                  lastSwitchAt: now,
                  updatedAt: now,
                },
                { baseDir },
              );
              detectedActiveAlias = matchedActive.alias;
            }
          }
        } catch {
          // Never fail import if active credential cannot be read.
        }
      }

      writeAccountIndex(index, { baseDir });
      return {
        imported,
        updated,
        skipped,
        detectedActiveAlias,
        total: index.accounts.length,
      };
    },
    { baseDir },
  );
}

export function saveCurrentAccount({
  alias = null,
  weight = undefined,
  force = false,
  storage = 'auto',
  baseDir = configDir(homedir()),
  home = homedir(),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  if (weight !== undefined && weight !== null) {
    normalizeAccountWeight(weight, { strict: true });
  }
  return withAccountLock(
    () => {
      const activeCred = readActiveAgyCredential({ home, keyring });
      if (!activeCred) {
        throw new Error('No active Antigravity CLI login found. Sign in with "agy" first, then run "agy-bar account save [alias]".');
      }
      const tokenInfo = parseAgyTokenPayload(activeCred.raw);
      const index = readAccountIndex({ baseDir });
      const matched = matchSlotForToken(index.accounts, tokenInfo);

      let chosenAlias;
      if (alias !== null && alias !== undefined && String(alias).trim() !== '') {
        chosenAlias = validateAlias(alias);
      } else if (matched) {
        chosenAlias = matched.alias;
      } else {
        chosenAlias = generateDefaultAlias(index.accounts);
      }

      const aliasOwner = index.accounts.find((a) => a.alias.toLowerCase() === chosenAlias.toLowerCase());
      let targetExisting = matched;

      if (aliasOwner && (!matched || aliasOwner.id !== matched.id)) {
        if (!force) {
          throw new Error(
            `Alias "${chosenAlias}" is already assigned to another account (${aliasOwner.maskedEmail || aliasOwner.id}). Choose a different alias or pass --force to replace it.`,
          );
        }
        // Replacing aliasOwner with this credential; remove old aliasOwner slot if matched already had another slot.
        if (matched && matched.id !== aliasOwner.id) {
          deleteVaultSecret(aliasOwner, { baseDir, keyring });
          index.accounts = index.accounts.filter((a) => a.id !== aliasOwner.id);
        } else {
          targetExisting = aliasOwner;
        }
      }

      const slotId = targetExisting?.id || createSlotId();
      const chosenStorage = storage === 'auto' && targetExisting?.storageBackend === 'file' && !keyring?.isAvailable?.()
        ? 'file'
        : storage;
      const actualStorage = writeVaultSecret(slotId, tokenInfo.raw, { storage: chosenStorage, baseDir, keyring });
      const saved = upsertSlotRecord(index, {
        existing: targetExisting ? { ...targetExisting, id: slotId } : { id: slotId },
        alias: chosenAlias,
        tokenInfo,
        storageBackend: actualStorage,
        weight,
        now,
      });
      writeAccountIndex(index, { baseDir });
      writeActiveAccountState(
        {
          activeAccountId: saved.id,
          activeQuotaKey: saved.quotaKey,
          lastSwitchAt: readActiveAccountState({ baseDir })?.lastSwitchAt ?? now,
          updatedAt: now,
        },
        { baseDir },
      );

      return {
        action: matched ? 'updated' : aliasOwner ? 'replaced' : 'saved',
        account: saved,
        source: activeCred.source,
      };
    },
    { baseDir },
  );
}

function writebackOutgoingSlot(index, state, outgoingRaw, { baseDir, keyring, now }) {
  if (!outgoingRaw) return { wroteBack: false, slot: null };
  let outgoingInfo;
  try {
    outgoingInfo = parseAgyTokenPayload(outgoingRaw);
  } catch {
    return { wroteBack: false, slot: null };
  }

  let outgoingSlot = matchSlotForToken(index.accounts, outgoingInfo);
  if (!outgoingSlot && state?.activeAccountId) {
    const byState = index.accounts.find((a) => a.id === state.activeAccountId);
    // Only trust state fallback if emailHash / subHash don't actively contradict it.
    if (
      byState &&
      (!outgoingInfo.emailHash || !byState.emailHash || outgoingInfo.emailHash === byState.emailHash) &&
      (!outgoingInfo.subHash || !byState.subHash || outgoingInfo.subHash === byState.subHash)
    ) {
      outgoingSlot = byState;
    }
  }

  if (!outgoingSlot) return { wroteBack: false, slot: null };

  const tokenChanged =
    outgoingInfo.accessTokenHash !== outgoingSlot.accessTokenHash ||
    outgoingInfo.refreshTokenHash !== outgoingSlot.refreshTokenHash;

  if (!tokenChanged) return { wroteBack: false, slot: outgoingSlot };

  const preferredStorage = outgoingSlot.storageBackend === 'file' ? 'file' : 'auto';
  const actualStorage = writeVaultSecret(outgoingSlot.id, outgoingInfo.raw, {
    storage: preferredStorage,
    baseDir,
    keyring,
  });
  const idx = index.accounts.findIndex((a) => a.id === outgoingSlot.id);
  if (idx >= 0) {
    index.accounts[idx] = {
      ...outgoingSlot,
      accessTokenHash: outgoingInfo.accessTokenHash || outgoingSlot.accessTokenHash,
      refreshTokenHash: outgoingInfo.refreshTokenHash || outgoingSlot.refreshTokenHash,
      expiry: outgoingInfo.expiry || outgoingSlot.expiry,
      maskedEmail: outgoingInfo.maskedEmail || outgoingSlot.maskedEmail,
      emailHash: outgoingInfo.emailHash || outgoingSlot.emailHash,
      subHash: outgoingInfo.subHash || outgoingSlot.subHash,
      quotaKey: outgoingInfo.emailHash || outgoingSlot.emailHash || outgoingSlot.quotaKey,
      storageBackend: actualStorage,
      lastRefreshedAt: now,
    };
  }
  return { wroteBack: true, slot: index.accounts[idx] || outgoingSlot };
}

export function switchToAccount(
  target,
  {
    baseDir = configDir(homedir()),
    home = homedir(),
    keyring = createKeyringBackend(),
    now = Date.now(),
  } = {},
) {
  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      if (index.accounts.length === 0) {
        throw new Error('No saved accounts yet. Run "agy-bar account save [alias]" to save your current login first.');
      }
      const targetSlot = resolveAccountTarget(index.accounts, target);
      if (!targetSlot) {
        const names = index.accounts.map((a) => a.alias).join(', ');
        throw new Error(`Account "${target}" not found. Saved accounts: ${names}`);
      }

      const targetSecret = readVaultSecret(targetSlot, { baseDir, keyring });
      if (!targetSecret) {
        throw new Error(
          `Stored credential for "${targetSlot.alias}" is missing from ${targetSlot.storageBackend} storage. Re-capture it with "agy-bar account add ${targetSlot.alias}".`,
        );
      }
      const targetInfo = parseAgyTokenPayload(targetSecret);

      const state = readActiveAccountState({ baseDir });
      let outgoing = null;
      try {
        outgoing = readActiveAgyCredential({ home, keyring });
      } catch {
        outgoing = null;
      }

      // Preserve any hourly access_token refresh on the outgoing account before swapping.
      const writeback = writebackOutgoingSlot(index, state, outgoing?.raw || null, { baseDir, keyring, now });

      try {
        writeActiveAgyCredential(targetInfo.raw, { home, keyring });
      } catch (err) {
        // Atomic rollback to outgoing credential if write failed halfway.
        if (outgoing?.raw) {
          try {
            writeActiveAgyCredential(outgoing.raw, { home, keyring });
          } catch {
            // Best-effort rollback.
          }
        }
        throw new Error(`Failed to activate account "${targetSlot.alias}": ${err.message}`);
      }

      const targetIdx = index.accounts.findIndex((a) => a.id === targetSlot.id);
      if (targetIdx >= 0) {
        index.accounts[targetIdx] = {
          ...index.accounts[targetIdx],
          lastUsedAt: now,
        };
      }
      writeAccountIndex(index, { baseDir });
      writeActiveAccountState(
        {
          activeAccountId: targetSlot.id,
          activeQuotaKey: targetSlot.quotaKey,
          lastSwitchAt: now,
          updatedAt: now,
        },
        { baseDir },
      );

      return {
        switched: true,
        fromAlias: writeback.slot?.alias || null,
        wroteBackOutgoing: writeback.wroteBack,
        account: index.accounts[targetIdx] || targetSlot,
      };
    },
    { baseDir },
  );
}

export function syncActiveAccountBeforeLaunch({
  baseDir = configDir(homedir()),
  home = homedir(),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  // Fast zero-touch path for users who have never configured multi-account.
  const state = readActiveAccountState({ baseDir });
  if (!state?.activeAccountId) {
    return { active: false, synced: false, reason: 'unused' };
  }

  return withAccountLock(
    () => {
      const freshState = readActiveAccountState({ baseDir });
      if (!freshState?.activeAccountId) {
        return { active: false, synced: false, reason: 'unused' };
      }
      const index = readAccountIndex({ baseDir });
      const desired = index.accounts.find((a) => a.id === freshState.activeAccountId);
      if (!desired) {
        return { active: false, synced: false, reason: 'missing-slot' };
      }

      let current = null;
      try {
        current = readActiveAgyCredential({ home, keyring });
      } catch {
        return { active: true, synced: false, reason: 'read-error', alias: desired.alias };
      }

      if (!current?.raw) {
        const desiredSecret = readVaultSecret(desired, { baseDir, keyring });
        if (!desiredSecret) {
          return { active: true, synced: false, reason: 'missing-secret', alias: desired.alias };
        }
        writeActiveAgyCredential(desiredSecret, { home, keyring });
        return { active: true, synced: true, restoredEmpty: true, alias: desired.alias };
      }

      let currentInfo;
      try {
        currentInfo = parseAgyTokenPayload(current.raw);
      } catch {
        return { active: true, synced: false, reason: 'unparseable-active', alias: desired.alias };
      }

      const matched = matchSlotForToken(index.accounts, currentInfo);
      if (!matched) {
        // User signed into a brand-new untracked account directly via `agy`; never clobber it.
        return { active: true, synced: false, reason: 'untracked-login', alias: desired.alias };
      }

      if (matched.id === desired.id) {
        // Same account: silently save refreshed access_token if hourly refresh occurred.
        const wb = writebackOutgoingSlot(index, freshState, current.raw, { baseDir, keyring, now });
        if (wb.wroteBack) {
          writeAccountIndex(index, { baseDir });
        }
        return { active: true, synced: false, refreshedWriteback: wb.wroteBack, alias: desired.alias };
      }

      // Drift detected: an older terminal refreshed `matched` and overwrote active credentials!
      // 1) Save the refreshed token back to `matched` so zero refresh state is lost.
      writebackOutgoingSlot(index, { activeAccountId: matched.id }, current.raw, { baseDir, keyring, now });
      // 2) Restore `desired` into active credentials.
      const desiredSecret = readVaultSecret(desired, { baseDir, keyring });
      if (!desiredSecret) {
        writeAccountIndex(index, { baseDir });
        return { active: true, synced: false, reason: 'missing-desired-secret', alias: desired.alias };
      }
      writeActiveAgyCredential(desiredSecret, { home, keyring });
      writeAccountIndex(index, { baseDir });
      return {
        active: true,
        synced: true,
        repairedFrom: matched.alias,
        alias: desired.alias,
      };
    },
    { baseDir },
  );
}

export function setAccountWeight(target, weight, { baseDir = configDir(homedir()), now = Date.now() } = {}) {
  const validWeight = normalizeAccountWeight(weight, { strict: true });
  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      const slot = resolveAccountTarget(index.accounts, target);
      if (!slot) {
        const names = index.accounts.map((a) => a.alias).join(', ');
        throw new Error(`Account "${target}" not found.${names ? ` Saved accounts: ${names}` : ''}`);
      }
      const oldWeight = normalizeAccountWeight(slot.weight, { fallback: DEFAULT_ACCOUNT_WEIGHT });
      slot.weight = validWeight;
      slot.updatedAt = now;
      writeAccountIndex(index, { baseDir });
      return {
        alias: slot.alias,
        oldWeight,
        newWeight: validWeight,
        account: slot,
      };
    },
    { baseDir },
  );
}

export function renameAccount(oldTarget, newAlias, { baseDir = configDir(homedir()), now = Date.now() } = {}) {
  const validNew = validateAlias(newAlias);
  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      const slot = resolveAccountTarget(index.accounts, oldTarget);
      if (!slot) {
        throw new Error(`Account "${oldTarget}" not found.`);
      }
      const collision = index.accounts.find((a) => a.id !== slot.id && a.alias.toLowerCase() === validNew.toLowerCase());
      if (collision) {
        throw new Error(`Alias "${validNew}" is already in use.`);
      }
      const oldAlias = slot.alias;
      slot.alias = validNew;
      slot.updatedAt = now;
      writeAccountIndex(index, { baseDir });
      return { oldAlias, newAlias: validNew, account: slot };
    },
    { baseDir },
  );
}

export function removeAccount(
  target,
  {
    baseDir = configDir(homedir()),
    keyring = createKeyringBackend(),
    now = Date.now(),
  } = {},
) {
  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      const slot = resolveAccountTarget(index.accounts, target);
      if (!slot) {
        throw new Error(`Account "${target}" not found.`);
      }
      deleteVaultSecret(slot, { baseDir, keyring });
      index.accounts = index.accounts.filter((a) => a.id !== slot.id);
      writeAccountIndex(index, { baseDir });

      const state = readActiveAccountState({ baseDir });
      if (state?.activeAccountId === slot.id) {
        writeActiveAccountState(
          {
            activeAccountId: null,
            activeQuotaKey: null,
            lastSwitchAt: state.lastSwitchAt,
            updatedAt: now,
          },
          { baseDir },
        );
      }

      return { removed: true, account: slot, remaining: index.accounts.length };
    },
    { baseDir },
  );
}

export function prepareForNewAccountLogin({
  baseDir = configDir(homedir()),
  home = homedir(),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  return withAccountLock(
    () => {
      const current = readActiveAgyCredential({ home, keyring });
      let preserved = null;
      if (current?.raw) {
        try {
          const info = parseAgyTokenPayload(current.raw);
          const index = readAccountIndex({ baseDir });
          const existing = matchSlotForToken(index.accounts, info);
          const alias = existing ? existing.alias : generateDefaultAlias(index.accounts);
          const slotId = existing?.id || createSlotId();
          const actualStorage = writeVaultSecret(slotId, info.raw, { storage: 'auto', baseDir, keyring });
          const saved = upsertSlotRecord(index, {
            existing: existing ? { ...existing, id: slotId } : { id: slotId },
            alias,
            tokenInfo: info,
            storageBackend: actualStorage,
            now,
          });
          writeAccountIndex(index, { baseDir });
          preserved = { alias: saved.alias, id: saved.id, raw: current.raw, existedBefore: Boolean(existing) };
        } catch {
          preserved = { alias: null, id: null, raw: current.raw, existedBefore: false };
        }
      }
      clearActiveAgyCredential({ home, keyring });
      return { preserved };
    },
    { baseDir },
  );
}

export function restorePreservedLogin(preserved, { home = homedir(), keyring = createKeyringBackend() } = {}) {
  if (!preserved?.raw) return false;
  writeActiveAgyCredential(preserved.raw, { home, keyring });
  return true;
}

export function exportEncryptedBackup({
  passphrase,
  baseDir = configDir(homedir()),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  const pass = String(passphrase ?? '');
  if (pass.length < 4) {
    throw new Error('Backup passphrase must be at least 4 characters long.');
  }

  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      if (index.accounts.length === 0) {
        throw new Error('No saved accounts to back up.');
      }
      const entries = [];
      for (const slot of index.accounts) {
        const rawSecret = readVaultSecret(slot, { baseDir, keyring });
        if (!rawSecret) continue;
        entries.push({
          alias: slot.alias,
          maskedEmail: slot.maskedEmail || null,
          emailHash: slot.emailHash || null,
          quotaKey: slot.quotaKey || null,
          tier: slot.tier || null,
          weight: normalizeAccountWeight(slot.weight, { fallback: DEFAULT_ACCOUNT_WEIGHT }),
          createdAt: slot.createdAt || now,
          lastUsedAt: slot.lastUsedAt || now,
          rawSecret,
        });
      }
      if (entries.length === 0) {
        throw new Error('No readable account credentials found in vault.');
      }

      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const plaintext = JSON.stringify({ version: 1, exportedAt: new Date(now).toISOString(), entries });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        format: 'agy-bar-vault-backup',
        version: 1,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm',
        count: entries.length,
        exportedAt: new Date(now).toISOString(),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    { baseDir },
  );
}

export function importEncryptedBackup(
  envelope,
  {
    passphrase,
    force = false,
    storage = 'auto',
    baseDir = configDir(homedir()),
    keyring = createKeyringBackend(),
    now = Date.now(),
  } = {},
) {
  if (!envelope || typeof envelope !== 'object' || envelope.format !== 'agy-bar-vault-backup') {
    throw new Error('Invalid backup file format (expected agy-bar-vault-backup).');
  }
  const pass = String(passphrase ?? '');
  if (!pass) {
    throw new Error('Passphrase is required to decrypt backup.');
  }

  let decrypted;
  try {
    const salt = Buffer.from(String(envelope.salt || ''), 'base64');
    const iv = Buffer.from(String(envelope.iv || ''), 'base64');
    const tag = Buffer.from(String(envelope.tag || ''), 'base64');
    const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
    const key = scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    decrypted = JSON.parse(plain);
  } catch {
    throw new Error('Failed to decrypt backup: invalid passphrase or corrupted file.');
  }

  if (!Array.isArray(decrypted?.entries)) {
    throw new Error('Backup payload is missing account entries.');
  }

  return withAccountLock(
    () => {
      const index = readAccountIndex({ baseDir });
      const imported = [];
      const updated = [];

      for (const item of decrypted.entries) {
        if (!item?.rawSecret) continue;
        const tokenInfo = parseAgyTokenPayload(item.rawSecret);
        const existing = matchSlotForToken(index.accounts, tokenInfo);
        let desiredAlias = ALIAS_REGEX.test(String(item.alias || '')) ? String(item.alias) : generateDefaultAlias(index.accounts);

        const collision = index.accounts.find((a) => a.alias.toLowerCase() === desiredAlias.toLowerCase());
        if (collision && (!existing || collision.id !== existing.id)) {
          if (force) {
            deleteVaultSecret(collision, { baseDir, keyring });
            index.accounts = index.accounts.filter((a) => a.id !== collision.id);
          } else {
            let suffix = 2;
            while (index.accounts.some((a) => a.alias.toLowerCase() === `${desiredAlias}-${suffix}`.toLowerCase())) {
              suffix += 1;
            }
            desiredAlias = `${desiredAlias}-${suffix}`.slice(0, 32);
          }
        }

        const slotId = existing?.id || createSlotId();
        const actualStorage = writeVaultSecret(slotId, tokenInfo.raw, { storage, baseDir, keyring });
        const saved = upsertSlotRecord(index, {
          existing: existing ? { ...existing, id: slotId } : { id: slotId, createdAt: item.createdAt || now },
          alias: existing && !force ? existing.alias : desiredAlias,
          tokenInfo,
          storageBackend: actualStorage,
          tier: item.tier || null,
          weight: item.weight !== undefined ? item.weight : undefined,
          maskedEmail: item.maskedEmail || null,
          emailHash: item.emailHash || null,
          now,
        });
        if (existing) updated.push(saved.alias);
        else imported.push(saved.alias);
      }

      writeAccountIndex(index, { baseDir });
      return {
        imported,
        updated,
        total: index.accounts.length,
      };
    },
    { baseDir },
  );
}

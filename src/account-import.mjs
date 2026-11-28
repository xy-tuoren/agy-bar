import { createDecipheriv } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { configDir } from './config.mjs';
import { createKeyringBackend } from './keyring.mjs';
import { hashAccountIdentifier, syncSharedQuota } from './quota-sync.mjs';
import { ALIAS_REGEX, maskEmail, upsertImportedAccounts } from './account-store.mjs';

export const IMPORT_SOURCES = Object.freeze(['auto', 'cockpit-tools', 'file']);

const COCKPIT_KEY_FILE = 'secure-account-storage.key';
const COCKPIT_LEGACY_KEY_FILE = 'account-token.key';

function decryptAes256GcmPayload(keyBuf, nonceB64, ciphertextB64) {
  const nonce = Buffer.from(String(nonceB64 || '').trim(), 'base64');
  const combined = Buffer.from(String(ciphertextB64 || '').trim(), 'base64');
  if (nonce.length !== 12 || combined.length < 16) {
    throw new Error('Invalid AES-256-GCM nonce or ciphertext length.');
  }
  // Rust aes-gcm crate appends the 16-byte authentication tag at the end of ciphertext.
  const tag = combined.subarray(combined.length - 16);
  const body = combined.subarray(0, combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function readCockpitKey(rootDir, filename) {
  const keyPath = join(rootDir, filename);
  if (!existsSync(keyPath)) {
    throw new Error(`Cockpit Tools encryption key not found at ${keyPath}`);
  }
  const keyBuf = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
  if (keyBuf.length !== 32) {
    throw new Error(`Invalid Cockpit Tools encryption key length at ${keyPath}`);
  }
  return keyBuf;
}

export function decodeCockpitAccountJson(content, rootDir = null) {
  const clean = String(content ?? '').replace(/^\uFEFF/, '').trim();
  const parsed = JSON.parse(clean);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Account file does not contain a JSON object.');
  }

  // Format 1: Current Cockpit Tools AES-256-GCM SecureAccountEnvelope.
  if (typeof parsed.ciphertext === 'string' && typeof parsed.nonce === 'string' && parsed.algorithm === 'AES-256-GCM') {
    if (!rootDir) {
      throw new Error('Encrypted Cockpit Tools account file requires its parent data directory containing secure-account-storage.key.');
    }
    const key = readCockpitKey(rootDir, COCKPIT_KEY_FILE);
    const plain = decryptAes256GcmPayload(key, parsed.nonce, parsed.ciphertext);
    return JSON.parse(plain);
  }

  // Format 2: Legacy token_encrypted envelope inside plaintext account JSON.
  if (parsed.token_encrypted && typeof parsed.token_encrypted === 'object' && !parsed.token) {
    if (!rootDir) {
      throw new Error('Legacy encrypted Cockpit Tools account file requires account-token.key.');
    }
    const key = readCockpitKey(rootDir, COCKPIT_LEGACY_KEY_FILE);
    const plainToken = decryptAes256GcmPayload(key, parsed.token_encrypted.nonce, parsed.token_encrypted.ciphertext);
    return {
      ...parsed,
      token: JSON.parse(plainToken),
    };
  }

  return parsed;
}

export function discoverCockpitToolsDataDir({ home = homedir(), env = process.env } = {}) {
  const candidates = [];

  const envDir = String(env.COCKPIT_TOOLS_DATA_DIR || '').trim();
  if (envDir) candidates.push(resolve(envDir));

  // Cockpit Tools stores optional custom root override in ~/.cockpit_tools-data-root.json.
  const prefFile = join(home, '.cockpit_tools-data-root.json');
  if (existsSync(prefFile)) {
    try {
      const custom = JSON.parse(readFileSync(prefFile, 'utf8'));
      if (typeof custom === 'string' && custom.trim() && isAbsolute(custom.trim())) {
        candidates.push(custom.trim());
      }
    } catch {
      // Ignore malformed preference file.
    }
  }

  candidates.push(join(home, '.cockpit_tools'));
  candidates.push(join(home, '.antigravity_cockpit'));

  for (const dir of candidates) {
    if (existsSync(join(dir, 'accounts')) && statSync(join(dir, 'accounts')).isDirectory()) {
      return dir;
    }
  }
  return null;
}

export function deriveAliasFromAccount(rawEmail, notes = null, fallbackIndex = 1) {
  const candidates = [];
  if (typeof notes === 'string' && notes.trim()) {
    const cleanNote = notes
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[^a-zA-Z0-9]+|[-._]+$/g, '')
      .slice(0, 24);
    if (cleanNote && ALIAS_REGEX.test(cleanNote)) {
      candidates.push(cleanNote);
    }
  }
  if (typeof rawEmail === 'string' && rawEmail.includes('@')) {
    const local = rawEmail
      .split('@')[0]
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[^a-zA-Z0-9]+|[-._]+$/g, '')
      .slice(0, 24);
    if (local && ALIAS_REGEX.test(local)) {
      candidates.push(local);
    }
  }
  return candidates[0] || `imported-${fallbackIndex}`;
}

export function normalizeTierLabel(quota) {
  const raw = String(quota?.subscription_tier || quota?.tier_id || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('ULTRA')) return 'ULTRA';
  if (raw.includes('PRO')) return 'PRO';
  if (raw.includes('FREE')) return 'FREE';
  return raw.slice(0, 12);
}

export function extractCockpitQuotaBuckets(quota) {
  if (!quota || typeof quota !== 'object') return null;
  const out = {};

  if (Array.isArray(quota.quota_summary_groups)) {
    for (const group of quota.quota_summary_groups) {
      if (!Array.isArray(group?.windows)) continue;
      for (const win of group.windows) {
        const id = typeof win?.id === 'string' ? win.id.trim() : '';
        if (!id) continue;
        // Map known Antigravity quota bucket IDs directly into agy-bar's quota-sync schema.
        let targetId = null;
        if (id === 'gemini-5h' || id === 'gemini-weekly' || id === '3p-5h' || id === '3p-weekly') {
          targetId = id;
        } else if (id.includes('gemini') && (id.includes('5h') || win.period === '5h')) {
          targetId = 'gemini-5h';
        } else if (id.includes('gemini') && (id.includes('weekly') || win.period === 'weekly')) {
          targetId = 'gemini-weekly';
        } else if ((id.includes('3p') || id.includes('claude')) && (id.includes('5h') || win.period === '5h')) {
          targetId = '3p-5h';
        } else if ((id.includes('3p') || id.includes('claude')) && (id.includes('weekly') || win.period === 'weekly')) {
          targetId = '3p-weekly';
        }
        if (!targetId) continue;

        const pct = Number(win.percentage);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;
        const resetTime = typeof win.reset_time === 'string' && win.reset_time.trim() ? win.reset_time.trim() : null;
        out[targetId] = {
          remaining_fraction: Math.max(0, Math.min(1, pct / 100)),
          ...(resetTime ? { reset_time: resetTime } : {}),
        };
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function convertExternalAccountToAgyCandidate(record, indexNum = 1, { includeDisabled = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { skipReason: 'invalid record' };
  }

  const rawEmail =
    (typeof record.email === 'string' && record.email.trim()) ||
    (typeof record.token?.email === 'string' && record.token.email.trim()) ||
    null;
  const masked = rawEmail ? maskEmail(rawEmail) : null;
  const emailHash = rawEmail ? hashAccountIdentifier(rawEmail) : null;
  const alias = deriveAliasFromAccount(rawEmail, record.notes || record.alias, indexNum);
  const tier = normalizeTierLabel(record.quota);

  if (record.disabled === true && !includeDisabled) {
    return {
      alias,
      maskedEmail: masked,
      tier,
      skipReason: record.disabled_reason ? `disabled (${record.disabled_reason})` : 'disabled',
    };
  }

  // Extract token fields from either nested `record.token` (Cockpit Tools / agy format) or flat export JSON.
  const tok = record.token && typeof record.token === 'object' ? record.token : record;
  const refreshToken = String(tok.refresh_token || tok.refreshToken || '').trim();
  const accessToken = String(tok.access_token || tok.accessToken || '').trim();
  const idToken = String(tok.id_token || tok.idToken || record.id_token || record.idToken || '').trim() || null;

  if (!refreshToken && !accessToken) {
    return { alias, maskedEmail: masked, tier, skipReason: 'missing refresh_token / access_token' };
  }

  // Convert expiry_timestamp (Unix seconds or ms) or ISO string into RFC3339 for agy's golang.org/x/oauth2.
  let expiryIso = '1970-01-01T00:00:00Z';
  if (typeof tok.expiry === 'string' && Number.isFinite(Date.parse(tok.expiry))) {
    expiryIso = new Date(Date.parse(tok.expiry)).toISOString();
  } else if (Number.isFinite(Number(tok.expiry_timestamp)) && Number(tok.expiry_timestamp) > 0) {
    const rawTs = Number(tok.expiry_timestamp);
    const ms = rawTs > 1e12 ? rawTs : rawTs * 1000;
    expiryIso = new Date(ms).toISOString();
  }

  const isGcp = Boolean(tok.is_gcp_tos || record.quota?.is_gcp_tos);
  const agyPayload = {
    token: {
      ...(accessToken ? { access_token: accessToken } : { access_token: '' }),
      token_type: typeof tok.token_type === 'string' && tok.token_type.trim() ? tok.token_type.trim() : 'Bearer',
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expiry: accessToken ? expiryIso : '1970-01-01T00:00:00Z',
    },
    auth_method: isGcp ? 'gcp' : 'consumer',
    ...(idToken ? { id_token: idToken } : {}),
  };

  const createdAt =
    Number.isFinite(Number(record.created_at)) && Number(record.created_at) > 0
      ? Number(record.created_at) > 1e12
        ? Number(record.created_at)
        : Number(record.created_at) * 1000
      : null;
  const lastUsedAt =
    Number.isFinite(Number(record.last_used)) && Number(record.last_used) > 0
      ? Number(record.last_used) > 1e12
        ? Number(record.last_used)
        : Number(record.last_used) * 1000
      : null;

  return {
    alias,
    maskedEmail: masked,
    emailHash,
    tier,
    createdAt,
    lastUsedAt,
    quotaBuckets: extractCockpitQuotaBuckets(record.quota),
    rawSecret: JSON.stringify(agyPayload),
  };
}

function loadCockpitDirectoryAccounts(dataDir, { includeDisabled = false } = {}) {
  const accountsFolder = join(dataDir, 'accounts');
  if (!existsSync(accountsFolder) || !statSync(accountsFolder).isDirectory()) {
    throw new Error(`Cockpit Tools accounts folder not found at ${accountsFolder}`);
  }

  const files = readdirSync(accountsFolder)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.bak') && !f.endsWith('.lock') && f !== 'index.json' && f !== 'accounts.json')
    .sort();

  const candidates = [];
  const skipped = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = join(accountsFolder, files[i]);
    try {
      const content = readFileSync(filePath, 'utf8');
      const decoded = decodeCockpitAccountJson(content, dataDir);
      const converted = convertExternalAccountToAgyCandidate(decoded, i + 1, { includeDisabled });
      if (converted.skipReason) {
        skipped.push({
          file: files[i],
          alias: converted.alias || null,
          maskedEmail: converted.maskedEmail || null,
          reason: converted.skipReason,
        });
      } else {
        candidates.push(converted);
      }
    } catch (err) {
      skipped.push({ file: files[i], alias: null, maskedEmail: null, reason: err.message });
    }
  }

  return { source: 'cockpit-tools', sourcePath: dataDir, candidates, skipped };
}

function loadJsonFileAccounts(filePath, { includeDisabled = false } = {}) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Import file not found: ${absPath}`);
  }
  const raw = readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);

  let rawRecords = [];
  if (Array.isArray(parsed)) {
    rawRecords = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.accounts)) {
      rawRecords = parsed.accounts;
    } else if (parsed.accounts && typeof parsed.accounts === 'object') {
      rawRecords = Object.entries(parsed.accounts).map(([emailKey, val]) =>
        val && typeof val === 'object' ? { email: emailKey, ...val } : null,
      );
    } else if (Array.isArray(parsed.items)) {
      rawRecords = parsed.items;
    } else if (Array.isArray(parsed.entries)) {
      rawRecords = parsed.entries;
    } else {
      rawRecords = [parsed];
    }
  }

  const candidates = [];
  const skipped = [];
  for (let i = 0; i < rawRecords.length; i++) {
    const converted = convertExternalAccountToAgyCandidate(rawRecords[i], i + 1, { includeDisabled });
    if (converted.skipReason) {
      skipped.push({
        alias: converted.alias || null,
        maskedEmail: converted.maskedEmail || null,
        reason: converted.skipReason,
      });
    } else {
      candidates.push(converted);
    }
  }

  return { source: 'file', sourcePath: absPath, candidates, skipped };
}

export function importExternalAccounts({
  targetPath = null,
  from = 'auto',
  force = false,
  includeDisabled = false,
  dryRun = false,
  storage = 'auto',
  home = homedir(),
  env = process.env,
  baseDir = configDir(homedir()),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  const normalizedFrom = String(from || 'auto').toLowerCase();
  if (!IMPORT_SOURCES.includes(normalizedFrom)) {
    throw new Error(`Invalid --from "${from}". Choose one of: ${IMPORT_SOURCES.join(', ')}`);
  }

  let loaded;
  if (targetPath) {
    const absTarget = resolve(targetPath);
    if (!existsSync(absTarget)) {
      throw new Error(`Import path not found: ${absTarget}`);
    }
    const st = statSync(absTarget);
    if (st.isDirectory()) {
      const rootDir = existsSync(join(absTarget, 'accounts')) ? absTarget : resolve(absTarget, '..');
      loaded = loadCockpitDirectoryAccounts(rootDir, { includeDisabled });
    } else {
      loaded = loadJsonFileAccounts(absTarget, { includeDisabled });
    }
  } else {
    if (normalizedFrom === 'file') {
      throw new Error('Specify a JSON file path when using "--from file". Example: agy-bar account import ./accounts.json');
    }
    const cockpitDir = discoverCockpitToolsDataDir({ home, env });
    if (!cockpitDir) {
      throw new Error(
        'Could not locate a Cockpit Tools data directory (~/.cockpit_tools or ~/.antigravity_cockpit). Pass a directory or exported JSON file path explicitly: agy-bar account import <path>',
      );
    }
    loaded = loadCockpitDirectoryAccounts(cockpitDir, { includeDisabled });
  }

  if (dryRun) {
    return {
      dryRun: true,
      source: loaded.source,
      sourcePath: loaded.sourcePath,
      candidates: loaded.candidates.map((c) => ({
        alias: c.alias,
        maskedEmail: c.maskedEmail,
        tier: c.tier,
        hasQuotaSeed: Boolean(c.quotaBuckets),
      })),
      imported: [],
      updated: [],
      skipped: loaded.skipped,
      total: loaded.candidates.length,
    };
  }

  const upsert = upsertImportedAccounts(loaded.candidates, {
    force,
    storage,
    home,
    baseDir,
    keyring,
    now,
  });

  // Seed agy-bar's passive quota-cache.json from Cockpit Tools' local snapshot (0 network calls!).
  let seededQuotas = 0;
  for (const entry of [...upsert.imported, ...upsert.updated]) {
    if (entry.quotaBuckets && entry.quotaKey) {
      syncSharedQuota(entry.quotaBuckets, {
        baseDir,
        now,
        accountKey: entry.quotaKey,
      });
      seededQuotas += 1;
    }
  }

  return {
    dryRun: false,
    source: loaded.source,
    sourcePath: loaded.sourcePath,
    imported: upsert.imported.map(({ quotaBuckets: _qb, ...rest }) => rest),
    updated: upsert.updated.map(({ quotaBuckets: _qb, ...rest }) => rest),
    skipped: [...loaded.skipped, ...upsert.skipped],
    detectedActiveAlias: upsert.detectedActiveAlias || null,
    seededQuotas,
    total: upsert.total,
  };
}

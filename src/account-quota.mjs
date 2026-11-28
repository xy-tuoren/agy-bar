import { homedir } from 'node:os';
import { bold, dim, fg, padDisplayEnd } from './ansi.mjs';
import { configDir } from './config.mjs';
import { readAccountIndex, readActiveAccountState, switchToAccount } from './account-store.mjs';
import { createKeyringBackend } from './keyring.mjs';
import {
  isBucketResetDue,
  isWeeklyBucketBlocking,
  parseRealResetTs,
  readAllAccountQuotas,
} from './quota-sync.mjs';
import { resolvePalette } from './themes.mjs';

export const ACCOUNT_FAMILIES = Object.freeze(['auto', 'gemini', 'claude']);

const STATUS_RANK = Object.freeze({
  READY: 3,
  LOW: 2,
  UNKNOWN: 1,
  LIMITED: 0,
});

function formatDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function formatRelativeAge(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return '--';
  const diffMs = Math.max(0, now - ts);
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

export function evaluateFamilyQuota(buckets, fiveHourId, weeklyId, now = Date.now()) {
  if (!buckets || typeof buckets !== 'object') {
    return {
      status: 'UNKNOWN',
      fiveHourPct: null,
      weeklyPct: null,
      resetDue: false,
      nextResetTs: null,
      nextResetLabel: null,
      observedAt: null,
    };
  }

  const b5 = buckets[fiveHourId] || null;
  const bw = buckets[weeklyId] || null;
  if (!b5 && !bw) {
    return {
      status: 'UNKNOWN',
      fiveHourPct: null,
      weeklyPct: null,
      resetDue: false,
      nextResetTs: null,
      nextResetLabel: null,
      observedAt: null,
    };
  }

  const weeklyResetDue = bw ? isBucketResetDue(bw, now) : false;
  const weeklyEffectiveFrac =
    bw && typeof bw.remaining_fraction === 'number'
      ? weeklyResetDue
        ? 1
        : bw.remaining_fraction
      : null;

  const weeklyBlocked = isWeeklyBucketBlocking(fiveHourId, buckets, now);
  const fiveHourResetDue = b5 ? isBucketResetDue(b5, now) && !weeklyBlocked : false;
  const fiveHourEffectiveFrac =
    b5 && typeof b5.remaining_fraction === 'number'
      ? fiveHourResetDue
        ? 1
        : b5.remaining_fraction
      : null;

  const fiveHourResetTs = b5 ? parseRealResetTs(b5) : null;
  const weeklyResetTs = bw ? parseRealResetTs(bw) : null;

  let status = 'UNKNOWN';
  let nextResetTs = null;

  if (weeklyBlocked || (weeklyEffectiveFrac !== null && weeklyEffectiveFrac <= 0.005)) {
    status = 'LIMITED';
    nextResetTs = weeklyResetTs && weeklyResetTs > now ? weeklyResetTs : null;
  } else if (fiveHourEffectiveFrac !== null && fiveHourEffectiveFrac <= 0.005) {
    status = 'LIMITED';
    nextResetTs = fiveHourResetTs && fiveHourResetTs > now ? fiveHourResetTs : null;
  } else if (
    (fiveHourEffectiveFrac !== null && fiveHourEffectiveFrac <= 0.2) ||
    (weeklyEffectiveFrac !== null && weeklyEffectiveFrac <= 0.2)
  ) {
    status = 'LOW';
    nextResetTs = fiveHourResetTs && fiveHourResetTs > now ? fiveHourResetTs : weeklyResetTs && weeklyResetTs > now ? weeklyResetTs : null;
  } else if (fiveHourEffectiveFrac !== null || weeklyEffectiveFrac !== null) {
    status = 'READY';
    nextResetTs = fiveHourResetTs && fiveHourResetTs > now ? fiveHourResetTs : null;
  }

  const observedAt = Math.max(Number(b5?.observedAt || 0), Number(bw?.observedAt || 0)) || null;

  return {
    status,
    fiveHourPct: fiveHourEffectiveFrac !== null ? Math.round(fiveHourEffectiveFrac * 100) : null,
    weeklyPct: weeklyEffectiveFrac !== null ? Math.round(weeklyEffectiveFrac * 100) : null,
    resetDue: fiveHourResetDue || weeklyResetDue,
    nextResetTs,
    nextResetLabel: nextResetTs ? formatDurationCompact(nextResetTs - now) : null,
    observedAt,
  };
}

function combineFamilyStatus(gemini, claude) {
  const rankG = STATUS_RANK[gemini.status] ?? 0;
  const rankC = STATUS_RANK[claude.status] ?? 0;
  if (rankG >= rankC) return gemini.status;
  return claude.status;
}

export function listAccountsWithQuota({
  baseDir = configDir(homedir()),
  now = Date.now(),
} = {}) {
  const index = readAccountIndex({ baseDir });
  const state = readActiveAccountState({ baseDir });
  const allQuotas = readAllAccountQuotas({ baseDir, now });

  return index.accounts.map((slot) => {
    const isActive = Boolean(state?.activeAccountId && state.activeAccountId === slot.id);
    const quotaEntry =
      allQuotas[slot.quotaKey] ||
      (slot.emailHash ? allQuotas[slot.emailHash] : null) ||
      (isActive ? allQuotas.default || null : null);
    const buckets = quotaEntry?.buckets || null;

    const gemini = evaluateFamilyQuota(buckets, 'gemini-5h', 'gemini-weekly', now);
    const claude = evaluateFamilyQuota(buckets, '3p-5h', '3p-weekly', now);
    const overallStatus = combineFamilyStatus(gemini, claude);

    return {
      ...slot,
      isActive,
      quotaUpdatedAt: quotaEntry?.updatedAt || null,
      gemini,
      claude,
      overallStatus,
    };
  });
}

function familyScore(row, family) {
  if (family === 'gemini') {
    return {
      statusRank: STATUS_RANK[row.gemini.status] ?? 0,
      fiveHour: row.gemini.fiveHourPct ?? -1,
      weekly: row.gemini.weeklyPct ?? -1,
      nextResetTs: row.gemini.nextResetTs ?? Number.MAX_SAFE_INTEGER,
    };
  }
  if (family === 'claude') {
    return {
      statusRank: STATUS_RANK[row.claude.status] ?? 0,
      fiveHour: row.claude.fiveHourPct ?? -1,
      weekly: row.claude.weeklyPct ?? -1,
      nextResetTs: row.claude.nextResetTs ?? Number.MAX_SAFE_INTEGER,
    };
  }
  // auto: prefer best available family across Gemini and Claude.
  const bestStatusRank = Math.max(STATUS_RANK[row.gemini.status] ?? 0, STATUS_RANK[row.claude.status] ?? 0);
  const fiveHour = Math.max(row.gemini.fiveHourPct ?? -1, row.claude.fiveHourPct ?? -1);
  const weekly = Math.max(row.gemini.weeklyPct ?? -1, row.claude.weeklyPct ?? -1);
  const nextResetTs = Math.min(
    row.gemini.nextResetTs ?? Number.MAX_SAFE_INTEGER,
    row.claude.nextResetTs ?? Number.MAX_SAFE_INTEGER,
  );
  return { statusRank: bestStatusRank, fiveHour, weekly, nextResetTs };
}

export function pickNextBestAccount(rows, { currentId = null, family = 'auto' } = {}) {
  const normalizedFamily = String(family || 'auto').toLowerCase();
  if (!ACCOUNT_FAMILIES.includes(normalizedFamily)) {
    throw new Error(`Invalid --family "${family}". Choose one of: ${ACCOUNT_FAMILIES.join(', ')}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidates = rows.length > 1 && currentId ? rows.filter((r) => r.id !== currentId) : [...rows];
  candidates.sort((a, b) => {
    const sa = familyScore(a, normalizedFamily);
    const sb = familyScore(b, normalizedFamily);
    if (sb.statusRank !== sa.statusRank) return sb.statusRank - sa.statusRank;
    if (sb.statusRank === STATUS_RANK.LIMITED) {
      // All remaining accounts limited -> pick whichever resets soonest.
      if (sa.nextResetTs !== sb.nextResetTs) return sa.nextResetTs - sb.nextResetTs;
    }
    if (sb.fiveHour !== sa.fiveHour) return sb.fiveHour - sa.fiveHour;
    if (sb.weekly !== sa.weekly) return sb.weekly - sa.weekly;
    // Natural round-robin tie-breaker: least recently used first.
    return Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0);
  });

  const winner = candidates[0];
  const score = familyScore(winner, normalizedFamily);
  return {
    account: winner,
    family: normalizedFamily,
    allLimited: score.statusRank === STATUS_RANK.LIMITED,
  };
}

export function detectQuotaFamilyFromModel(model) {
  const raw =
    typeof model === 'string'
      ? model
      : `${model?.id || ''} ${model?.display_name || ''}`;
  const lower = raw.toLowerCase();
  if (/claude|sonnet|opus|haiku|anthropic|3p/.test(lower)) return 'claude';
  if (/gemini|neon|carbon|argon|hydrogen|flash|pro/.test(lower)) return 'gemini';
  return 'auto';
}

export function isAccountLimitedForFamily(row, family = 'auto') {
  if (!row) return false;
  if (family === 'gemini') return row.gemini?.status === 'LIMITED';
  if (family === 'claude') return row.claude?.status === 'LIMITED';
  return row.overallStatus === 'LIMITED';
}

export function computeSwapHint({
  payload = null,
  activeAccountId = null,
  baseDir = configDir(homedir()),
  now = Date.now(),
} = {}) {
  if (!activeAccountId) return null;
  const family = detectQuotaFamilyFromModel(payload?.model);
  const liveQuota = payload?.quota && typeof payload.quota === 'object' ? payload.quota : null;

  // Ultra-fast check against live statusline payload before reading accounts index.
  if (liveQuota) {
    const liveGemini = evaluateFamilyQuota(liveQuota, 'gemini-5h', 'gemini-weekly', now);
    const liveClaude = evaluateFamilyQuota(liveQuota, '3p-5h', '3p-weekly', now);
    const liveLimited =
      family === 'gemini'
        ? liveGemini.status === 'LIMITED'
        : family === 'claude'
          ? liveClaude.status === 'LIMITED'
          : combineFamilyStatus(liveGemini, liveClaude) === 'LIMITED';
    if (!liveLimited) return null;
  }

  const rows = listAccountsWithQuota({ baseDir, now });
  if (rows.length < 2) return null;
  const activeRow = rows.find((r) => r.id === activeAccountId);
  if (!activeRow) return null;
  if (!liveQuota && !isAccountLimitedForFamily(activeRow, family)) return null;

  const pick = pickNextBestAccount(rows, { currentId: activeAccountId, family });
  if (!pick || pick.allLimited || pick.account.id === activeAccountId) return null;
  const famInfo = family === 'claude' ? pick.account.claude : family === 'gemini' ? pick.account.gemini : pick.account.gemini.status === 'READY' ? pick.account.gemini : pick.account.claude;

  return {
    alias: pick.account.alias,
    family,
    status: pick.account.overallStatus,
    fiveHourPct: famInfo?.fiveHourPct ?? null,
  };
}

export function findAutoSwitchCandidate({
  family = 'auto',
  excludeIds = [],
  baseDir = configDir(homedir()),
  now = Date.now(),
} = {}) {
  const state = readActiveAccountState({ baseDir });
  if (!state?.activeAccountId) {
    return { shouldSwitch: false, reason: 'unused' };
  }
  const rows = listAccountsWithQuota({ baseDir, now });
  if (rows.length < 2) {
    return { shouldSwitch: false, reason: 'single-account' };
  }
  const activeRow = rows.find((r) => r.id === state.activeAccountId);
  if (!activeRow) {
    return { shouldSwitch: false, reason: 'missing-active' };
  }
  if (!isAccountLimitedForFamily(activeRow, family)) {
    return { shouldSwitch: false, reason: 'not-limited', activeAlias: activeRow.alias, family };
  }

  const excluded = new Set([activeRow.id, ...excludeIds]);
  const remaining = rows.filter((r) => !excluded.has(r.id));
  if (remaining.length === 0) {
    return { shouldSwitch: false, reason: 'no-remaining-accounts', activeAlias: activeRow.alias, family };
  }

  const pick = pickNextBestAccount(remaining, { currentId: null, family });
  if (!pick || pick.allLimited) {
    return {
      shouldSwitch: false,
      reason: 'all-limited',
      activeAlias: activeRow.alias,
      family,
      soonestAlias: pick?.account?.alias || null,
    };
  }

  return {
    shouldSwitch: true,
    reason: 'active-limited',
    family,
    fromId: activeRow.id,
    fromAlias: activeRow.alias,
    toId: pick.account.id,
    toAlias: pick.account.alias,
    toAccount: pick.account,
  };
}

export function maybeAutoSwitchAccount({
  family = 'auto',
  excludeIds = [],
  baseDir = configDir(homedir()),
  home = homedir(),
  keyring = createKeyringBackend(),
  now = Date.now(),
} = {}) {
  const decision = findAutoSwitchCandidate({ family, excludeIds, baseDir, now });
  if (!decision.shouldSwitch) {
    return { switched: false, ...decision };
  }
  const res = switchToAccount(decision.toAlias, { baseDir, home, keyring, now });
  return {
    switched: true,
    reason: decision.reason,
    family: decision.family,
    fromId: decision.fromId,
    fromAlias: decision.fromAlias,
    toId: res.account.id,
    toAlias: res.account.alias,
    wroteBackOutgoing: res.wroteBackOutgoing,
    account: res.account,
  };
}

export function sanitizeAccountForJson(row) {
  return {
    id: row.id,
    alias: row.alias,
    active: Boolean(row.isActive),
    maskedEmail: row.maskedEmail || null,
    tier: row.tier || null,
    authMethod: row.authMethod || 'oauth',
    hasRefreshToken: Boolean(row.hasRefreshToken),
    storageBackend: row.storageBackend || 'file',
    status: row.overallStatus,
    gemini: {
      status: row.gemini.status,
      fiveHourPct: row.gemini.fiveHourPct,
      weeklyPct: row.gemini.weeklyPct,
      resetDue: row.gemini.resetDue,
      nextResetIn: row.gemini.nextResetLabel,
    },
    claude: {
      status: row.claude.status,
      fiveHourPct: row.claude.fiveHourPct,
      weeklyPct: row.claude.weeklyPct,
      resetDue: row.claude.resetDue,
      nextResetIn: row.claude.nextResetLabel,
    },
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    quotaUpdatedAt: row.quotaUpdatedAt ? new Date(row.quotaUpdatedAt).toISOString() : null,
  };
}

function renderMiniGauge(pct, palette, color, width = 5) {
  if (pct === null || pct === undefined) return dim('·'.repeat(width), color);
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  const tone = clamped <= 5 ? palette.danger : clamped <= 20 ? palette.warn : palette.good;
  return `${fg('█'.repeat(filled), tone, color)}${fg('░'.repeat(empty), palette.track, color)}`;
}

function renderFamilyCell(fam, palette, color) {
  if (fam.status === 'UNKNOWN') return dim('--', color);
  const bar = renderMiniGauge(fam.fiveHourPct, palette, color);
  const p5 = fam.fiveHourPct !== null ? `${String(fam.fiveHourPct).padStart(3)}%` : ' --';
  const pw = fam.weeklyPct !== null ? ` 7d:${fam.weeklyPct}%` : '';
  const suffix = fam.status === 'LIMITED' && fam.nextResetLabel
    ? fg(` ↻${fam.nextResetLabel}`, palette.warn, color)
    : fam.resetDue
      ? fg(' ↻ready', palette.good, color)
      : '';
  return `${bar} ${p5}${dim(pw, color)}${suffix}`;
}

function renderStatusBadge(status, palette, color) {
  if (status === 'READY') return fg('READY  ', palette.good, color);
  if (status === 'LOW') return fg('LOW    ', palette.warn, color);
  if (status === 'LIMITED') return fg('LIMITED', palette.danger, color);
  return dim('UNKNOWN', color);
}

export function formatAccountTable(rows, { color = true, theme = 'auto', now = Date.now() } = {}) {
  const { palette, color: themeAllowsColor } = resolvePalette(theme);
  const useColor = Boolean(color && themeAllowsColor);
  if (!rows || rows.length === 0) {
    return [
      'No saved Antigravity accounts yet.',
      '  Save current login:  agy-bar account save work',
      '  Add another account: agy-bar account add alt1',
    ].join('\n');
  }

  const lines = [
    bold('agy-bar accounts', useColor) + dim(`  (${rows.length} saved · passive quota cache, zero private API)`, useColor),
    '',
    `  ${padDisplayEnd('Account', 16)} ${padDisplayEnd('Status', 8)} ${padDisplayEnd('Gemini (5h / 7d)', 24)} ${padDisplayEnd('Claude (5h / 7d)', 24)} ${padDisplayEnd('Store', 9)} Last Used`,
    dim(`  ${'─'.repeat(94)}`, useColor),
  ];

  for (const row of rows) {
    const marker = row.isActive ? fg('● ', palette.good, useColor) : '  ';
    const aliasText = row.isActive ? bold(row.alias, useColor) : row.alias;
    const tierBadge = row.tier
      ? ` ${fg(`[${row.tier}]`, row.tier === 'ULTRA' ? palette.warn : row.tier === 'PRO' ? palette.accent : palette.muted, useColor)}`
      : '';
    const emailPart = row.maskedEmail ? dim(`(${row.maskedEmail})`, useColor) : '';
    const subline = [emailPart, tierBadge.trim()].filter(Boolean).join(' ');
    const accountCell = `${marker}${aliasText}`;
    const statusCell = renderStatusBadge(row.overallStatus, palette, useColor);
    const geminiCell = renderFamilyCell(row.gemini, palette, useColor);
    const claudeCell = renderFamilyCell(row.claude, palette, useColor);
    const storeCell = dim(row.storageBackend || 'file', useColor);
    const ageCell = dim(formatRelativeAge(row.lastUsedAt, now), useColor);

    lines.push(
      `  ${padDisplayEnd(accountCell, 16)} ${padDisplayEnd(statusCell, 8)} ${padDisplayEnd(geminiCell, 24)} ${padDisplayEnd(claudeCell, 24)} ${padDisplayEnd(storeCell, 9)} ${ageCell}`,
    );
    if (subline) {
      lines.push(`    ${subline}`);
    }
  }

  lines.push('');
  lines.push(
    dim(
      '  Switch: agy-bar switch <alias>   |   Auto-pick best: agy-bar switch next   |   With context: agy-bar switch next --handoff',
      useColor,
    ),
  );
  return lines.join('\n');
}

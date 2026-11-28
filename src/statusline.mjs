import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSwapHint } from './account-quota.mjs';
import { readActiveAccountState } from './account-store.mjs';
import { classifyAgentActivity, extractNativeCostUsd } from './agent-state.mjs';
import { sanitizeText } from './ansi.mjs';
import { loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { getOrRefreshUsageSummary } from './history-scan.mjs';
import { maybeTriggerBackgroundPricingSync } from './pricing-sync.mjs';
import { extractAccountKey, syncSharedQuota } from './quota-sync.mjs';
import { renderFallback, renderStatusline } from './render.mjs';
import { readConversationSummaryTitle, readLatestStepTiming } from './step-timing.mjs';
import { syncTabTitle } from './tab-title.mjs';
import { deriveSessionId, maybeCaptureRedactedPayload, peekSessionState, recordTelemetry, resolveSessionTitles } from './telemetry.mjs';
import { isNativeTitleActive } from './title.mjs';

const GIT_DIRTY_CACHE_MS = 3000;

export async function runStatusline({ stdin = process.stdin, stdout = process.stdout, env = process.env, argv = process.argv } = {}) {
  let raw = '';
  for await (const chunk of stdin) {
    raw += chunk;
  }

  const config = loadConfig();
  const plain = argv.includes('--plain');
  const color = !('NO_COLOR' in env) && String(env.TERM || '').toLowerCase() !== 'dumb' && !plain && config.theme !== 'mono';

  try {
    const payload = JSON.parse(raw);
    const now = Date.now();
    maybeCaptureRedactedPayload(payload);
    const activeAccountState = readActiveAccountState();
    const syncedQuota = payload?.quota
      ? syncSharedQuota(payload.quota, {
          now,
          accountKey: extractAccountKey(payload, { fallbackAccountKey: activeAccountState?.activeQuotaKey ?? null }),
        })
      : null;
    const effectivePayload = syncedQuota && syncedQuota !== payload.quota ? { ...payload, quota: syncedQuota } : payload;
    const prevSession = peekSessionState(effectivePayload);
    const cwd = effectivePayload?.workspace?.current_dir || effectivePayload?.cwd || null;
    const wantGitStatus = Boolean(config.show.gitDirty || config.show.gitDiff);
    const canReuseGitStatus = Boolean(
      wantGitStatus &&
        prevSession &&
        prevSession.cwd === cwd &&
        typeof prevSession.gitCheckedAt === 'number' &&
        now - prevSession.gitCheckedAt < GIT_DIRTY_CACHE_MS &&
        (!config.show.gitDiff || (typeof prevSession.gitAdded === 'number' && typeof prevSession.gitRemoved === 'number')),
    );
    const git =
      config.show.git && cwd
        ? readGitInfo(cwd, {
            checkDirty: config.show.gitDirty,
            checkDiff: config.show.gitDiff,
            cachedDirty: canReuseGitStatus ? Boolean(prevSession.dirty) : null,
            cachedDiff:
              canReuseGitStatus && config.show.gitDiff
                ? { added: prevSession.gitAdded, removed: prevSession.gitRemoved }
                : null,
          })
        : null;

    const hasPayloadTitle = Boolean(sanitizeText(effectivePayload?.conversation_title || ''));
    const summaryTitle =
      config.tabTitle && !hasPayloadTitle && config.tabTitleSource !== 'dir' && config.dbTiming !== false
        ? readConversationSummaryTitle(effectivePayload, {
            prevDbStamp: prevSession?.summaryDbStamp ?? null,
            prevTitle: prevSession?.conversationTitle ?? null,
            prevCheckedAt: prevSession?.summaryTitleCheckedAt ?? null,
            now,
            recheckIntervalMs: 15_000,
          })
        : null;
    const { conversationTitle, customTitle } = resolveSessionTitles(effectivePayload, prevSession, {
      dbTitle: summaryTitle?.title ?? null,
    });
    const payloadForTitle =
      conversationTitle && !hasPayloadTitle
        ? { ...effectivePayload, conversation_title: conversationTitle }
        : effectivePayload;

    // Sync terminal tab title synchronously before async DB scans when AGY's native
    // `settings.json.title` hook is not already driving this session's title, OR as a
    // one-shot push the moment a brand-new conversation's initial summary title lands.
    let tabSync = null;
    const sessionIdForTitle = deriveSessionId(effectivePayload);
    const nativeActive = !plain && config.tabTitle ? isNativeTitleActive(sessionIdForTitle, { now, hostPid: process.ppid }) : false;
    if (!plain && config.tabTitle) {
      const newlyDiscoveredDbTitle = Boolean(!hasPayloadTitle && !prevSession?.conversationTitle && conversationTitle && !customTitle);
      if (!nativeActive || newlyDiscoveredDbTitle) {
        tabSync = syncTabTitle(payloadForTitle, {
          config,
          git,
          customTitle,
          prevTabTitle: prevSession?.lastTabTitle || null,
          prevTabHostPid: prevSession?.lastTabHostPid ?? null,
          prevTabTty: prevSession?.lastTabTty || null,
          hostPidHint: process.ppid,
          force: nativeActive && newlyDiscoveredDbTitle,
          resolveOpts: { env },
        });
      }
    }

    const stepTiming = config.dbTiming
      ? await readLatestStepTiming(effectivePayload, {
          prevDbStamp: prevSession?.dbStamp ?? null,
          prevWaitingForInput: Boolean(prevSession?.dbWaitingForInput),
        })
      : null;

    // During ask_question prompts, AGY keeps agent_state="working" while steps.status=9 in local DB.
    // Promote waiting_for_input on the live payload and push a one-shot tab update on transitions.
    const dbWaitingNow = Boolean(stepTiming?.waitingForInput);
    const dbWaitingPrev = Boolean(prevSession?.dbWaitingForInput);
    const livePayload =
      dbWaitingNow && effectivePayload.waiting_for_input !== true
        ? { ...effectivePayload, waiting_for_input: true }
        : effectivePayload;

    if (!plain && config.tabTitle && dbWaitingNow !== dbWaitingPrev) {
      const liveTitlePayload =
        conversationTitle && !hasPayloadTitle
          ? { ...livePayload, conversation_title: conversationTitle }
          : livePayload;
      tabSync = syncTabTitle(liveTitlePayload, {
        config,
        git,
        customTitle,
        prevTabTitle: tabSync?.title || prevSession?.lastTabTitle || null,
        prevTabHostPid: tabSync?.hostPid ?? prevSession?.lastTabHostPid ?? null,
        prevTabTty: (tabSync?.tty && tabSync.tty !== 'custom' ? tabSync.tty : null) || prevSession?.lastTabTty || null,
        hostPidHint: process.ppid,
        force: nativeActive,
        resolveOpts: { env },
      });
    }

    const telemetry = recordTelemetry(livePayload, {
      now,
      git,
      stepTiming,
      summaryTitle,
      prevSession,
      tabSync,
      cacheTtlSec: config.cacheTtlSec,
      enableLedger: config.ledger,
    });

    const activity = classifyAgentActivity(livePayload);
    let usageSummary = null;
    if (
      config.show.todayTokens ||
      config.show.weekTokens ||
      config.show.monthTokens ||
      config.show.totalTokens ||
      config.show.todayCost ||
      config.show.cost
    ) {
      usageSummary = await getOrRefreshUsageSummary({
        now,
        sessionId: telemetry.sessionId,
        deltaTokens: telemetry.turnTokensDelta || 0,
        deltaCostUsd: telemetry.turnCostDeltaUsd || 0,
        hasRunningSubagents: activity.runningSubagents > 0,
        allowScan: config.dbTiming,
      });
    }

    const nativeCostUsd = extractNativeCostUsd(livePayload);
    const effectiveSessionCostUsd = Math.max(telemetry.sessionCostUsd || 0, usageSummary?.sessionCostUsd || 0, nativeCostUsd || 0);
    const effectiveTelemetry =
      effectiveSessionCostUsd !== telemetry.sessionCostUsd
        ? { ...telemetry, sessionCostUsd: effectiveSessionCostUsd }
        : telemetry;

    if (config.pricingAutoSync) {
      maybeTriggerBackgroundPricingSync({ enabled: true, now, env });
    }

    const swapHint =
      config.swapHint !== false && activeAccountState?.activeAccountId
        ? computeSwapHint({
            payload: livePayload,
            activeAccountId: activeAccountState.activeAccountId,
            now,
          })
        : null;

    const rendered = renderStatusline(livePayload, {
      config,
      now,
      color,
      git,
      telemetry: effectiveTelemetry,
      usageSummary,
      swapHint,
      env,
      themeOptions: { env },
    });
    stdout.write(`${rendered}\n`);
  } catch {
    const fallback = renderFallback(config, { color });
    stdout.write(`${fallback}\n`);
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectInvocation()) {
  await runStatusline();
}

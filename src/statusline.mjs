import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { getOrRefreshUsageSummary } from './history-scan.mjs';
import { maybeTriggerBackgroundPricingSync } from './pricing-sync.mjs';
import { renderFallback, renderStatusline } from './render.mjs';
import { readLatestStepTiming } from './step-timing.mjs';
import { syncTabTitle } from './tab-title.mjs';
import { maybeCaptureRedactedPayload, peekSessionState, recordTelemetry, updateSessionTabTitle } from './telemetry.mjs';

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
    const prevSession = peekSessionState(payload);
    const cwd = payload?.workspace?.current_dir || payload?.cwd || null;
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
    const stepTiming = config.dbTiming
      ? await readLatestStepTiming(payload, { prevDbStamp: prevSession?.dbStamp ?? null })
      : null;
    const telemetry = recordTelemetry(payload, {
      now,
      git,
      stepTiming,
      prevSession,
      cacheTtlSec: config.cacheTtlSec,
      enableLedger: config.ledger,
    });

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
        allowScan: config.dbTiming,
      });
    }

    const effectiveSessionCostUsd = Math.max(telemetry.sessionCostUsd || 0, usageSummary?.sessionCostUsd || 0);
    const effectiveTelemetry =
      effectiveSessionCostUsd !== telemetry.sessionCostUsd
        ? { ...telemetry, sessionCostUsd: effectiveSessionCostUsd }
        : telemetry;

    if (!plain && config.tabTitle) {
      const tab = syncTabTitle(payload, {
        config,
        git,
        customTitle: telemetry.customTitle,
        prevTabTitle: telemetry.prevTabTitle,
        prevTabHostPid: telemetry.prevTabHostPid,
        hostPidHint: process.ppid,
        resolveOpts: { env },
      });
      if (tab.changed && tab.title) {
        updateSessionTabTitle(telemetry.sessionId, tab.title, { hostPid: tab.hostPid });
      }
    }

    if (config.pricingAutoSync) {
      maybeTriggerBackgroundPricingSync({ enabled: true, now, env });
    }

    const rendered = renderStatusline(payload, {
      config,
      now,
      color,
      git,
      telemetry: effectiveTelemetry,
      usageSummary,
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

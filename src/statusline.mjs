import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { renderFallback, renderStatusline } from './render.mjs';
import { readLatestStepTiming } from './step-timing.mjs';
import { syncTabTitle } from './tab-title.mjs';
import { maybeCaptureRedactedPayload, recordTelemetry, updateSessionTabTitle } from './telemetry.mjs';

export async function runStatusline({ stdin = process.stdin, stdout = process.stdout, env = process.env, argv = process.argv } = {}) {
  let raw = '';
  for await (const chunk of stdin) {
    raw += chunk;
  }

  const config = loadConfig();
  const plain = argv.includes('--plain');
  const color = !('NO_COLOR' in env) && !plain && config.theme !== 'mono';

  try {
    const payload = JSON.parse(raw);
    maybeCaptureRedactedPayload(payload);
    const cwd = payload?.workspace?.current_dir || payload?.cwd || null;
    const git = config.show.git && cwd ? readGitInfo(cwd, { checkDirty: config.show.gitDirty }) : null;
    const stepTiming = config.dbTiming ? await readLatestStepTiming(payload) : null;
    const telemetry = recordTelemetry(payload, {
      git,
      stepTiming,
      cacheTtlSec: config.cacheTtlSec,
      enableLedger: config.ledger,
    });

    if (!plain && config.tabTitle) {
      const tab = syncTabTitle(payload, {
        config,
        git,
        customTitle: telemetry.customTitle,
        prevTabTitle: telemetry.prevTabTitle,
        resolveOpts: { env },
      });
      if (tab.changed && tab.title) {
        updateSessionTabTitle(telemetry.sessionId, tab.title);
      }
    }

    const rendered = renderStatusline(payload, { config, color, git, telemetry, themeOptions: { env } });
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

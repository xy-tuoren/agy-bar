import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeText } from './ansi.mjs';
import { configDir, loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { buildTabTitle } from './tab-title.mjs';
import { deriveSessionId, peekSessionState, resolveSessionTitles, sessionsDir } from './telemetry.mjs';

const NATIVE_TITLE_FRESH_MS = 60_000;
const NATIVE_TITLE_TOUCH_INTERVAL_MS = 120_000;

export function nativeTitleMarkerPath(sessionId, baseDir = configDir(homedir())) {
  return join(sessionsDir(baseDir), `${sessionId}.title`);
}

export function touchNativeTitleMarker(
  sessionId,
  { now = Date.now(), hostPid = process.ppid, baseDir = configDir(homedir()) } = {},
) {
  if (!sessionId) return false;
  const markerPath = nativeTitleMarkerPath(sessionId, baseDir);
  try {
    if (existsSync(markerPath)) {
      const [rawTs, rawPid] = readFileSync(markerPath, 'utf8').trim().split(':');
      const prevTs = Number(rawTs);
      const prevPid = Number(rawPid);
      if (
        Number.isFinite(prevTs) &&
        now - prevTs < NATIVE_TITLE_TOUCH_INTERVAL_MS &&
        Number.isFinite(prevPid) &&
        prevPid === hostPid
      ) {
        return true;
      }
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${now}:${Number.isFinite(hostPid) ? hostPid : 0}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function isNativeTitleActive(
  sessionId,
  { now = Date.now(), hostPid = process.ppid, baseDir = configDir(homedir()) } = {},
) {
  if (!sessionId) return false;
  const markerPath = nativeTitleMarkerPath(sessionId, baseDir);
  if (!existsSync(markerPath)) return false;
  try {
    const [rawTs, rawPid] = readFileSync(markerPath, 'utf8').trim().split(':');
    const ts = Number(rawTs);
    const pid = Number(rawPid);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    const ageMs = now - ts;
    if (ageMs < 0) return true;
    if (ageMs < NATIVE_TITLE_FRESH_MS) return true;
    if (ageMs < 24 * 60 * 60 * 1000 && Number.isFinite(pid) && pid > 1 && typeof hostPid === 'number' && pid === hostPid) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function renderNativeTitle(
  payload = {},
  { config = loadConfig(), prevSession = undefined, baseDir = configDir(homedir()), now = Date.now(), hostPid = process.ppid, touchMarker = true } = {},
) {
  if (config.tabTitle === false) return '';

  const p = payload && typeof payload === 'object' ? payload : {};
  const sessionId = deriveSessionId(p);
  const prev = prevSession !== undefined ? prevSession : peekSessionState(p, { baseDir });
  const { customTitle } = resolveSessionTitles(p, prev);

  const cwd = p?.workspace?.current_dir || p?.cwd || prev?.cwd || null;
  const needsGit =
    config.tabTitleSource === 'dir' ||
    (!customTitle && !sanitizeText(p?.conversation_title || ''));
  let git = null;
  if (needsGit && cwd) {
    if (prev && prev.cwd === cwd && prev.branch) {
      git = { branch: prev.branch, dirty: Boolean(prev.dirty) };
    } else {
      // Zero-subprocess .git/HEAD lookup only.
      git = readGitInfo(cwd, { checkDirty: false, checkDiff: false });
    }
  }

  const title = buildTabTitle(p, { config, git, customTitle });
  if (touchMarker) {
    touchNativeTitleMarker(sessionId, { now, hostPid, baseDir });
  }
  return title ? sanitizeText(title).replace(/[\r\n\t]+/g, ' ') : '';
}

export async function runTitleCommand({
  stdin = process.stdin,
  stdout = process.stdout,
  baseDir = configDir(homedir()),
  config = undefined,
} = {}) {
  let raw = '';
  for await (const chunk of stdin) {
    raw += chunk;
  }

  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const cfg = config ?? loadConfig();
    const title = renderNativeTitle(payload, { config: cfg, baseDir });
    if (title) {
      stdout.write(`${title}\n`);
    }
  } catch {
    // Never emit error noise into the terminal window title.
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
  await runTitleCommand();
}

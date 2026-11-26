import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { classifyAgentActivity } from './agent-state.mjs';
import { clipPlain, sanitizeText, visibleWidth } from './ansi.mjs';

const VALID_TTY_RE = /^(?:tty[a-z0-9]+|pts\/\d+)$/i;

const FILLER_PREFIXES = [
  /^(?:请|麻烦|能不能|可以|能否)?(?:帮我|给我|帮忙)/,
  /^(?:我想|我要|请问|为什么这个|为什么|看看这个|看看)/,
  /^(?:please|can you|could you|help me|i want to|i need to)\s+/i,
];

export function compactTitleText(raw, maxCols = 26) {
  let text = sanitizeText(raw)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^\/[a-z0-9_-]+\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (const re of FILLER_PREFIXES) {
    const stripped = text.replace(re, '').trim();
    if (stripped.length >= 3) text = stripped;
  }

  text = text.replace(/^[，。、：:；;？！?!\-\s]+|[，。、：:；;？！?!\-\s]+$/g, '').trim();
  if (!text) return '';

  const limit = Math.max(8, Math.min(60, Math.round(maxCols || 26)));
  if (visibleWidth(text) <= limit) return text;
  return `${clipPlain(text, Math.max(4, limit - 1)).trimEnd()}…`;
}

export function buildTabTitle(
  payload = {},
  {
    config = {},
    git = null,
    customTitle = null,
  } = {},
) {
  const source = config.tabTitleSource || 'auto';
  const maxCols = config.tabTitleMaxLen || 26;
  const activity = classifyAgentActivity(payload);
  const prefix = activity.tabPrefix;

  const rawCwd = payload?.workspace?.current_dir || payload?.cwd || '';
  const dirName = rawCwd ? sanitizeText(basename(rawCwd)) : '';
  const branch = git?.branch ? sanitizeText(git.branch) : '';
  const dirLabel = dirName && branch ? `${dirName} (${branch}${git?.dirty ? '*' : ''})` : dirName || branch;

  let body = '';
  const cleanCustom = customTitle ? compactTitleText(customTitle, maxCols) : '';
  const cleanConv = payload?.conversation_title ? compactTitleText(payload.conversation_title, maxCols) : '';

  if (cleanCustom) {
    body = cleanCustom;
  } else if (source === 'dir') {
    body = compactTitleText(dirLabel, maxCols);
  } else if (source === 'title+dir') {
    if (dirName && cleanConv) {
      const restCols = Math.max(8, maxCols - visibleWidth(dirName) - 3);
      body = `${dirName} · ${compactTitleText(payload.conversation_title, restCols)}`;
    } else {
      body = cleanConv || compactTitleText(dirLabel, maxCols);
    }
  } else {
    // 'auto' or 'title': prefer AGY's conversation_title, fall back to workspace/git dir.
    body = cleanConv || compactTitleText(dirLabel, maxCols);
  }

  if (!body) return '';
  return `${prefix}${body}`;
}

export function formatOscTitle(title) {
  const safe = sanitizeText(title).replace(/[\x07\x1b]/g, '');
  if (!safe) return '';
  // Emit both OSC 0 (icon/tab + window) and OSC 2 (window/surface) for Ghostty/iTerm2/Kitty/WezTerm compatibility.
  return `\x1b]0;${safe}\x07\x1b]2;${safe}\x07`;
}

function defaultReadProc(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 120,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(out);
    if (!match) return null;
    return { ppid: Number(match[1]), tty: match[2], comm: match[3].trim() };
  } catch {
    return null;
  }
}

function isWritable(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTerminalTarget({
  env = process.env,
  platform = process.platform,
  pid = process.pid,
  readProc = defaultReadProc,
  canWrite = isWritable,
} = {}) {
  if (platform === 'win32') return { tty: null, hostPid: null };

  if (env.AGY_BAR_TTY) {
    return { tty: env.AGY_BAR_TTY, hostPid: null };
  }

  // Walk up ancestor processes so we reliably find the `agy` host tab's TTY & PID
  // even when invoked inside a subshell or tool-execution PTY.
  let currentPid = pid;
  let fallbackTty = null;
  let fallbackPid = null;
  for (let hop = 0; hop < 5 && currentPid > 1; hop++) {
    const info = readProc(currentPid);
    if (!info) break;
    const ttyName = info.tty;
    if (ttyName && ttyName !== '??' && ttyName !== '?' && VALID_TTY_RE.test(ttyName)) {
      const devPath = `/dev/${ttyName}`;
      if (canWrite(devPath)) {
        if (/(?:^|\/)agy$/i.test(info.comm)) {
          return { tty: devPath, hostPid: currentPid };
        }
        if (!fallbackTty && hop > 0) {
          fallbackTty = devPath;
          fallbackPid = currentPid;
        }
      }
    }
    if (!info.ppid || info.ppid === currentPid) break;
    currentPid = info.ppid;
  }

  if (fallbackTty) return { tty: fallbackTty, hostPid: fallbackPid };
  if (canWrite('/dev/tty')) return { tty: '/dev/tty', hostPid: null };
  return { tty: null, hostPid: null };
}

export function resolveTerminalTty(opts = {}) {
  return resolveTerminalTarget(opts).tty;
}

export function writeOscTitle(title, { ttyPath = null, writer = null, resolveOpts = {} } = {}) {
  const seq = formatOscTitle(title);
  if (!seq) return { written: false, tty: null, hostPid: null, sequence: '' };

  if (typeof writer === 'function') {
    writer(seq);
    return { written: true, tty: ttyPath || 'custom', hostPid: null, sequence: seq };
  }

  const resolved = ttyPath ? { tty: ttyPath, hostPid: null } : resolveTerminalTarget(resolveOpts);
  if (!resolved.tty) return { written: false, tty: null, hostPid: null, sequence: seq };

  let fd = null;
  try {
    fd = openSync(resolved.tty, 'w');
    writeSync(fd, seq);
    return { written: true, tty: resolved.tty, hostPid: resolved.hostPid, sequence: seq };
  } catch {
    return { written: false, tty: resolved.tty, hostPid: resolved.hostPid, sequence: seq };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

export function syncTabTitle(
  payload,
  {
    config = {},
    git = null,
    customTitle = null,
    prevTabTitle = null,
    prevTabHostPid = null,
    hostPidHint = null,
    force = false,
    ttyPath = null,
    writer = null,
    resolveOpts = {},
  } = {},
) {
  if (config.tabTitle === false) {
    return { changed: false, written: false, title: null, tty: null, hostPid: null };
  }

  const title = buildTabTitle(payload, { config, git, customTitle });
  if (!title) {
    return { changed: false, written: false, title: null, tty: null, hostPid: null };
  }

  // Fast path: skip spawning `ps` when neither title nor host agy PID changed.
  if (
    !force &&
    !writer &&
    !ttyPath &&
    title === prevTabTitle &&
    prevTabHostPid !== null &&
    typeof hostPidHint === 'number' &&
    hostPidHint === prevTabHostPid
  ) {
    return { changed: false, written: false, title, tty: null, hostPid: prevTabHostPid };
  }

  const resolved = !writer && !ttyPath ? resolveTerminalTarget(resolveOpts) : { tty: ttyPath, hostPid: null };
  const hostChanged = resolved.hostPid !== null && prevTabHostPid !== null && resolved.hostPid !== prevTabHostPid;
  const hostUnknownBefore = resolved.hostPid !== null && prevTabHostPid === null;

  if (!force && title === prevTabTitle && !hostChanged && !hostUnknownBefore) {
    return { changed: false, written: false, title, tty: resolved.tty, hostPid: resolved.hostPid };
  }

  const result = writeOscTitle(title, { ttyPath: resolved.tty, writer, resolveOpts });
  return { changed: true, written: result.written, title, tty: result.tty, hostPid: resolved.hostPid };
}

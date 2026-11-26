import { execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

export const PROXY_MODES = Object.freeze(['auto', 'manual', 'off']);
export const DEFAULT_PROXY_BYPASS = Object.freeze(['127.0.0.1', 'localhost', '::1', '.local']);
export const DEFAULT_PROXY_CONFIG = Object.freeze({
  mode: 'auto',
  url: null,
  bypass: DEFAULT_PROXY_BYPASS,
});

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const REQUIRED_LOOPBACK_BYPASS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

export const COMMON_LOCAL_PROXY_PORTS = Object.freeze([
  Object.freeze({ port: 7897, protocol: 'http', label: 'Clash Verge / Mihomo' }),
  Object.freeze({ port: 7890, protocol: 'http', label: 'Clash / Mihomo' }),
  Object.freeze({ port: 6152, protocol: 'http', label: 'Surge' }),
  Object.freeze({ port: 10809, protocol: 'http', label: 'v2rayN HTTP' }),
  Object.freeze({ port: 1087, protocol: 'http', label: 'ClashX / V2RayU' }),
  Object.freeze({ port: 20171, protocol: 'http', label: 'v2rayA HTTP' }),
  Object.freeze({ port: 20172, protocol: 'http', label: 'v2rayA Mixed' }),
  Object.freeze({ port: 10808, protocol: 'socks5', label: 'v2rayN SOCKS5' }),
  Object.freeze({ port: 1080, protocol: 'socks5', label: 'SOCKS5' }),
]);

export function sanitizeBypassEntry(entry) {
  const trimmed = String(entry || '').trim();
  if (!trimmed || trimmed === '<local>') return null;
  if (trimmed.startsWith('*.')) return trimmed.slice(1);
  return trimmed;
}

export function normalizeBypassList(input, fallback = DEFAULT_PROXY_BYPASS) {
  const rawList = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,;\s]+/)
      : null;

  if (!rawList) return [...fallback];

  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    const clean = sanitizeBypassEntry(item);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.length > 0 ? out : [...fallback];
}

export function validateProxyUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('Proxy URL cannot be empty. Example: http://127.0.0.1:7897');
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid proxy URL "${raw}". Example: http://127.0.0.1:7897`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported proxy protocol "${parsed.protocol}". Use http://, https://, socks5://, or socks5h://.`,
    );
  }

  if (!parsed.hostname) {
    throw new Error(`Proxy URL "${raw}" is missing a hostname.`);
  }

  const defaultPort = parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : 1080;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy port in "${raw}".`);
  }

  // Strip trailing slash from root origin URLs so env vars stay canonical.
  const normalizedUrl = parsed.pathname === '/' && !parsed.search && !parsed.hash
    ? parsed.href.replace(/\/$/, '')
    : parsed.href;

  const isSocks = parsed.protocol === 'socks5:' || parsed.protocol === 'socks5h:';
  const warning = isSocks
    ? 'Go gRPC clients prefer an HTTP CONNECT proxy (http://127.0.0.1:<port>) over SOCKS5. If your client exposes a mixed/HTTP port (e.g. 7897 or 7890), use http:// instead.'
    : null;

  return {
    url: normalizedUrl,
    protocol: parsed.protocol.slice(0, -1),
    host: parsed.hostname,
    port,
    warning,
  };
}

export function normalizeProxyConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      mode: DEFAULT_PROXY_CONFIG.mode,
      url: DEFAULT_PROXY_CONFIG.url,
      bypass: [...DEFAULT_PROXY_BYPASS],
    };
  }

  const mode = PROXY_MODES.includes(raw.mode) ? raw.mode : DEFAULT_PROXY_CONFIG.mode;
  let url = null;
  if (typeof raw.url === 'string' && raw.url.trim()) {
    try {
      url = validateProxyUrl(raw.url).url;
    } catch {
      url = null;
    }
  }
  const bypass = normalizeBypassList(raw.bypass, DEFAULT_PROXY_BYPASS);
  return { mode, url, bypass };
}

export function isDefaultProxyConfig(proxyCfg) {
  const norm = normalizeProxyConfig(proxyCfg);
  if (norm.mode !== DEFAULT_PROXY_CONFIG.mode) return false;
  if (norm.url !== null) return false;
  if (norm.bypass.length !== DEFAULT_PROXY_BYPASS.length) return false;
  return norm.bypass.every((item, i) => item === DEFAULT_PROXY_BYPASS[i]);
}

export function redactProxyUrl(raw) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) {
      return parsed.pathname === '/' && !parsed.search && !parsed.hash
        ? parsed.href.replace(/\/$/, '')
        : parsed.href;
    }
    const auth = '***@';
    const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    const suffix = parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.protocol}//${auth}${hostPort}${suffix}`;
  } catch {
    return String(raw).replace(/\/\/[^/@]+@/, '//***@');
  }
}

export function parseScutilProxy(output) {
  const text = String(output || '');
  if (!text.trim()) return null;

  const kv = new Map();
  const exceptions = [];
  let inExceptions = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('ExceptionsList')) {
      inExceptions = true;
      continue;
    }
    if (inExceptions) {
      if (line === '}') {
        inExceptions = false;
        continue;
      }
      const exMatch = line.match(/^\d+\s*:\s*(.+)$/);
      if (exMatch) {
        const clean = sanitizeBypassEntry(exMatch[1]);
        if (clean) exceptions.push(clean);
      }
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
    if (match) {
      kv.set(match[1], match[2].trim());
    }
  }

  const bypass = exceptions.length > 0 ? normalizeBypassList([...REQUIRED_LOOPBACK_BYPASS, ...exceptions]) : [...DEFAULT_PROXY_BYPASS];

  // Prefer HTTP/HTTPS proxy over SOCKS5 for Go/gRPC HTTP CONNECT compatibility.
  if (kv.get('HTTPSEnable') === '1' && kv.get('HTTPSProxy') && kv.get('HTTPSPort')) {
    return {
      url: `http://${kv.get('HTTPSProxy')}:${kv.get('HTTPSPort')}`,
      source: 'macOS system HTTPS proxy',
      bypass,
    };
  }
  if (kv.get('HTTPEnable') === '1' && kv.get('HTTPProxy') && kv.get('HTTPPort')) {
    return {
      url: `http://${kv.get('HTTPProxy')}:${kv.get('HTTPPort')}`,
      source: 'macOS system HTTP proxy',
      bypass,
    };
  }
  if (kv.get('SOCKSEnable') === '1' && kv.get('SOCKSProxy') && kv.get('SOCKSPort')) {
    return {
      url: `socks5://${kv.get('SOCKSProxy')}:${kv.get('SOCKSPort')}`,
      source: 'macOS system SOCKS5 proxy',
      bypass,
    };
  }
  return null;
}

export function parseWindowsRegProxy(output) {
  const text = String(output || '');
  if (!text.trim()) return null;

  const enableMatch = text.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
  if (!enableMatch || parseInt(enableMatch[1], 16) !== 1) return null;

  const serverMatch = text.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
  if (!serverMatch) return null;
  const rawServer = serverMatch[1].trim();
  if (!rawServer) return null;

  let chosenUrl = null;
  if (rawServer.includes('=')) {
    const map = new Map();
    for (const part of rawServer.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      map.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
    }
    if (map.get('https')) chosenUrl = `http://${map.get('https').replace(/^https?:\/\//i, '')}`;
    else if (map.get('http')) chosenUrl = `http://${map.get('http').replace(/^https?:\/\//i, '')}`;
    else if (map.get('socks')) chosenUrl = `socks5://${map.get('socks').replace(/^socks5?:\/\//i, '')}`;
  } else {
    chosenUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`;
  }

  if (!chosenUrl) return null;

  const overrideMatch = text.match(/ProxyOverride\s+REG_SZ\s+(.+)/i);
  const bypass = overrideMatch
    ? normalizeBypassList([...REQUIRED_LOOPBACK_BYPASS, ...overrideMatch[1].split(';')])
    : [...DEFAULT_PROXY_BYPASS];

  return {
    url: validateProxyUrl(chosenUrl).url,
    source: 'Windows system proxy',
    bypass,
  };
}

export function checkLocalPort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false;
    const finish = (reachable, error = null) => {
      if (settled) return;
      settled = true;
      resolve({
        reachable,
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        error,
      });
    };

    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      socket.destroy();
      finish(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      finish(false, 'timeout');
    });
    socket.once('error', (err) => {
      socket.destroy();
      finish(false, err?.code || err?.message || 'error');
    });
  });
}

function defaultExecCmd(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function readEnvProxy(env = process.env) {
  const candidates = [
    ['HTTPS_PROXY', env.HTTPS_PROXY],
    ['https_proxy', env.https_proxy],
    ['HTTP_PROXY', env.HTTP_PROXY],
    ['http_proxy', env.http_proxy],
    ['ALL_PROXY', env.ALL_PROXY],
    ['all_proxy', env.all_proxy],
  ];
  for (const [name, value] of candidates) {
    if (!value || !String(value).trim()) continue;
    try {
      const parsed = validateProxyUrl(value);
      const rawNoProxy = env.NO_PROXY || env.no_proxy || '';
      const bypass = rawNoProxy
        ? normalizeBypassList([...REQUIRED_LOOPBACK_BYPASS, ...rawNoProxy.split(',')])
        : [...DEFAULT_PROXY_BYPASS];
      return {
        url: parsed.url,
        source: `environment (${name})`,
        bypass,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function detectLocalProxy({
  platform = process.platform,
  env = process.env,
  includeEnv = false,
  execCmd = defaultExecCmd,
  probePort = checkLocalPort,
  probeTimeoutMs = 180,
} = {}) {
  if (includeEnv) {
    const fromEnv = readEnvProxy(env);
    if (fromEnv) return fromEnv;
  }

  // 1. OS-level system proxy settings (fast, accurate port + bypass list).
  if (platform === 'darwin') {
    try {
      const parsed = parseScutilProxy(execCmd('scutil', ['--proxy']));
      if (parsed) return parsed;
    } catch {
      // Fall through to localhost port probe.
    }
  } else if (platform === 'win32') {
    try {
      const output = execCmd('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ]);
      const parsed = parseWindowsRegProxy(output);
      if (parsed) return parsed;
    } catch {
      // Fall through to localhost port probe.
    }
  }

  // 2. Parallel localhost probe on common local proxy ports (works even when both TUN & system proxy are OFF).
  const results = await Promise.all(
    COMMON_LOCAL_PROXY_PORTS.map(async (entry) => ({
      entry,
      check: await probePort('127.0.0.1', entry.port, probeTimeoutMs),
    })),
  );

  for (const { entry, check } of results) {
    if (check.reachable) {
      return {
        url: `${entry.protocol}://127.0.0.1:${entry.port}`,
        source: `localhost:${entry.port} (${entry.label})`,
        bypass: [...DEFAULT_PROXY_BYPASS],
      };
    }
  }

  return null;
}

export async function resolveEffectiveProxy(
  proxyCfg,
  {
    overrideUrl = null,
    noProxy = false,
    platform = process.platform,
    env = process.env,
    execCmd = defaultExecCmd,
    probePort = checkLocalPort,
  } = {},
) {
  const cfg = normalizeProxyConfig(proxyCfg);

  if (noProxy) {
    return { active: false, reason: 'bypassed via --no-proxy', url: null, source: null, bypass: cfg.bypass, warning: null };
  }

  if (overrideUrl) {
    const parsed = validateProxyUrl(overrideUrl);
    return {
      active: true,
      required: true,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      protocol: parsed.protocol,
      source: 'CLI --proxy flag',
      bypass: cfg.bypass,
      warning: parsed.warning,
    };
  }

  if (cfg.mode === 'off') {
    return { active: false, reason: 'disabled (mode=off)', url: null, source: null, bypass: cfg.bypass, warning: null };
  }

  if (cfg.mode === 'manual') {
    if (!cfg.url) {
      return { active: false, reason: 'manual mode has no URL set', url: null, source: null, bypass: cfg.bypass, warning: null };
    }
    const parsed = validateProxyUrl(cfg.url);
    return {
      active: true,
      required: true,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      protocol: parsed.protocol,
      source: 'saved config',
      bypass: cfg.bypass,
      warning: parsed.warning,
    };
  }

  // mode === 'auto'
  const detected = await detectLocalProxy({ platform, env, includeEnv: true, execCmd, probePort });
  if (detected) {
    const parsed = validateProxyUrl(detected.url);
    const mergedBypass = normalizeBypassList([...cfg.bypass, ...(detected.bypass || [])]);
    return {
      active: true,
      required: false,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      protocol: parsed.protocol,
      source: detected.source,
      bypass: mergedBypass,
      warning: parsed.warning,
    };
  }

  // Fall back to saved URL if present even in auto mode.
  if (cfg.url) {
    const parsed = validateProxyUrl(cfg.url);
    return {
      active: true,
      required: false,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      protocol: parsed.protocol,
      source: 'saved fallback config',
      bypass: cfg.bypass,
      warning: parsed.warning,
    };
  }

  return {
    active: false,
    reason: 'no local proxy detected',
    url: null,
    source: null,
    bypass: cfg.bypass,
    warning: null,
  };
}

export function buildProxyEnv(resolved, baseEnv = process.env, { stripExisting = false } = {}) {
  const env = { ...baseEnv };

  if (stripExisting || !resolved?.active || !resolved?.url) {
    if (stripExisting) {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        delete env[key];
      }
    }
    return env;
  }

  const url = resolved.url;
  const existingNoProxy = env.NO_PROXY || env.no_proxy || '';
  const noProxyEntries = normalizeBypassList([
    ...REQUIRED_LOOPBACK_BYPASS,
    ...(resolved.bypass || DEFAULT_PROXY_BYPASS),
    ...(existingNoProxy ? existingNoProxy.split(',') : []),
  ]);
  const noProxy = noProxyEntries.join(',');

  env.HTTP_PROXY = url;
  env.HTTPS_PROXY = url;
  env.ALL_PROXY = url;
  env.http_proxy = url;
  env.https_proxy = url;
  env.all_proxy = url;
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  return env;
}

export function formatShellExports(resolved, { shell = 'sh' } = {}) {
  const noProxy = normalizeBypassList([
    ...REQUIRED_LOOPBACK_BYPASS,
    ...(resolved?.bypass || DEFAULT_PROXY_BYPASS),
  ]).join(',');

  if (!resolved?.active || !resolved?.url) {
    if (shell === 'pwsh') {
      return [
        'Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY,Env:http_proxy,Env:https_proxy,Env:all_proxy -ErrorAction SilentlyContinue',
      ].join('\n');
    }
    if (shell === 'fish') {
      return 'set -e HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy';
    }
    return 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy';
  }

  const url = resolved.url;
  const vars = [
    ['HTTP_PROXY', url],
    ['HTTPS_PROXY', url],
    ['ALL_PROXY', url],
    ['http_proxy', url],
    ['https_proxy', url],
    ['all_proxy', url],
    ['NO_PROXY', noProxy],
    ['no_proxy', noProxy],
  ];

  if (shell === 'pwsh') {
    const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
    return vars.map(([k, v]) => `$env:${k} = ${q(v)}`).join('\n');
  }
  if (shell === 'fish') {
    const q = (v) => `'${String(v).replaceAll("'", "\\'")}'`;
    return vars.map(([k, v]) => `set -gx ${k} ${q(v)}`).join('\n');
  }
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  return vars.map(([k, v]) => `export ${k}=${q(v)}`).join('\n');
}

export function parseRunArgs(args = []) {
  const options = {
    proxyUrl: null,
    noProxy: false,
    agyBin: null,
    quiet: false,
  };
  const agyArgs = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      agyArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--no-proxy') {
      options.noProxy = true;
      i += 1;
      continue;
    }
    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
      i += 1;
      continue;
    }
    if (arg === '--proxy') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --proxy. Example: agy-bar run --proxy http://127.0.0.1:7897');
      options.proxyUrl = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--proxy=')) {
      const value = arg.slice('--proxy='.length);
      if (!value) throw new Error('Missing value for --proxy=');
      options.proxyUrl = value;
      i += 1;
      continue;
    }
    if (arg === '--agy-bin') {
      const value = args[i + 1];
      if (!value) throw new Error('Missing value for --agy-bin');
      options.agyBin = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--agy-bin=')) {
      const value = arg.slice('--agy-bin='.length);
      if (!value) throw new Error('Missing value for --agy-bin=');
      options.agyBin = value;
      i += 1;
      continue;
    }

    // First non-wrapper argument: forward this and everything after verbatim to agy.
    agyArgs.push(...args.slice(i));
    break;
  }

  return { options, agyArgs };
}

export async function launchAgyWithProxy(
  rawArgs = [],
  {
    proxyConfig,
    env = process.env,
    platform = process.platform,
    execCmd = defaultExecCmd,
    probePort = checkLocalPort,
    spawnFn = spawn,
    stderr = process.stderr,
  } = {},
) {
  if (env.AGY_BAR_PROXY_WRAPPER === '1') {
    throw new Error(
      'Detected recursive agy-bar run invocation. Point --agy-bin to the real agy executable instead of a wrapper script.',
    );
  }

  const { options, agyArgs } = parseRunArgs(rawArgs);
  const executable = options.agyBin || env.AGY_BIN || 'agy';

  const resolved = await resolveEffectiveProxy(proxyConfig, {
    overrideUrl: options.proxyUrl,
    noProxy: options.noProxy,
    platform,
    env,
    execCmd,
    probePort,
  });

  if (resolved.active) {
    const check = await probePort(resolved.host, resolved.port, 500);
    if (!check.reachable) {
      if (resolved.required) {
        throw new Error(
          `Proxy ${redactProxyUrl(resolved.url)} is not listening (${check.error || 'unreachable'}). Start your proxy app (Clash/Surge/v2ray) or run with --no-proxy.`,
        );
      }
      if (!options.quiet) {
        stderr.write(
          `agy-bar: proxy ${redactProxyUrl(resolved.url)} is not reachable — launching ${executable} directly\n`,
        );
      }
      resolved.active = false;
    } else if (!options.quiet) {
      stderr.write(
        `agy-bar: launching ${executable} via ${redactProxyUrl(resolved.url)} (${resolved.source}, no-TUN)\n`,
      );
      if (resolved.warning) {
        stderr.write(`agy-bar: note: ${resolved.warning}\n`);
      }
    }
  } else if (!options.quiet && !options.noProxy && normalizeProxyConfig(proxyConfig).mode !== 'off') {
    stderr.write(
      `agy-bar: no local proxy detected — launching ${executable} directly (set one with "agy-bar proxy set http://127.0.0.1:7897")\n`,
    );
  }

  const childEnv = buildProxyEnv(resolved, env, { stripExisting: options.noProxy });
  childEnv.AGY_BAR_PROXY_WRAPPER = '1';

  return new Promise((resolve, reject) => {
    const child = spawnFn(executable, agyArgs, {
      stdio: 'inherit',
      env: childEnv,
      shell: false,
    });

    // Forward termination signals; let child TUI own interactive Ctrl+C (SIGINT).
    const onSigInt = () => {};
    const onSigTerm = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if already exited.
      }
    };
    const onSigHup = () => {
      try {
        child.kill('SIGHUP');
      } catch {
        // Ignore if already exited.
      }
    };

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    if (platform !== 'win32') process.on('SIGHUP', onSigHup);

    const cleanup = () => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      if (platform !== 'win32') process.off('SIGHUP', onSigHup);
    };

    child.once('error', (err) => {
      cleanup();
      if (err?.code === 'ENOENT') {
        reject(
          new Error(
            `Could not find "${executable}" in PATH. Ensure Antigravity CLI (agy) is installed or pass --agy-bin <path>.`,
          ),
        );
        return;
      }
      reject(err);
    });

    child.once('exit', (code, signal) => {
      cleanup();
      resolve({
        exitCode: typeof code === 'number' ? code : signal ? 128 : 0,
        signal: signal || null,
        proxy: resolved,
      });
    });
  });
}

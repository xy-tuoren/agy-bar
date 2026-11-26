import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const HOOK_START = '# >>> agy-bar proxy >>>';
export const HOOK_END = '# <<< agy-bar proxy <<<';
export const SUPPORTED_SHELLS = Object.freeze(['zsh', 'bash', 'fish', 'pwsh']);

export function detectShell({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return 'pwsh';
  const raw = String(env.SHELL || '').trim();
  const name = basename(raw).toLowerCase();
  if (name === 'zsh') return 'zsh';
  if (name === 'fish') return 'fish';
  if (name === 'bash' || name === 'sh') return 'bash';
  return platform === 'darwin' ? 'zsh' : 'bash';
}

export function resolveShellRcPath({ home = homedir(), shell = null, platform = process.platform, env = process.env } = {}) {
  const chosen = shell ? String(shell).toLowerCase() : detectShell({ platform, env });
  if (!SUPPORTED_SHELLS.includes(chosen)) {
    throw new Error(`Unsupported shell "${shell}". Choose one of: ${SUPPORTED_SHELLS.join(', ')}`);
  }

  if (chosen === 'zsh') {
    const zdot = env.ZDOTDIR && home === homedir() ? env.ZDOTDIR : home;
    return { shell: 'zsh', rcPath: join(zdot, '.zshrc'), reloadCmd: `source ${join(zdot, '.zshrc')}` };
  }

  if (chosen === 'bash') {
    const bashrc = join(home, '.bashrc');
    const bashProfile = join(home, '.bash_profile');
    const target = platform === 'darwin' && !existsSync(bashrc) && existsSync(bashProfile) ? bashProfile : bashrc;
    return { shell: 'bash', rcPath: target, reloadCmd: `source ${target}` };
  }

  if (chosen === 'fish') {
    const target = join(home, '.config', 'fish', 'config.fish');
    return { shell: 'fish', rcPath: target, reloadCmd: `source ${target}` };
  }

  const pwsh7Dir = join(home, 'Documents', 'PowerShell');
  const winPsDir = join(home, 'Documents', 'WindowsPowerShell');
  const psModulePath = String(env.PSModulePath || '');
  const looksLikeWinPs5 = !psModulePath.includes('PowerShell\\7') && existsSync(winPsDir) && !existsSync(pwsh7Dir);
  const target = join(looksLikeWinPs5 ? winPsDir : pwsh7Dir, 'Microsoft.PowerShell_profile.ps1');
  return { shell: 'pwsh', rcPath: target, reloadCmd: '. $PROFILE' };
}

export function buildShellHookBlock(shell) {
  if (shell === 'fish') {
    return [
      HOOK_START,
      'function agy --wraps agy',
      '  if test -x "$HOME/.local/bin/agy-bar"',
      '    "$HOME/.local/bin/agy-bar" run --from-hook -- $argv',
      '  else',
      '    command agy $argv',
      '  end',
      'end',
      HOOK_END,
    ].join('\n');
  }

  if (shell === 'pwsh') {
    return [
      HOOK_START,
      'function agy {',
      "  $agyBar = Join-Path $HOME '.local\\bin\\agy-bar.cmd'",
      '  if (Test-Path $agyBar) {',
      "    & $agyBar run --from-hook '--' @args",
      '  } else {',
      '    $bin = (Get-Command agy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source',
      '    if ($bin) { & $bin @args }',
      '  }',
      '}',
      HOOK_END,
    ].join('\r\n');
  }

  // zsh & bash
  return [
    HOOK_START,
    'agy() {',
    '  if [ -x "$HOME/.local/bin/agy-bar" ]; then',
    '    "$HOME/.local/bin/agy-bar" run --from-hook -- "$@"',
    '  else',
    '    command agy "$@"',
    '  fi',
    '}',
    HOOK_END,
  ].join('\n');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HOOK_BLOCK_RE = new RegExp(`(?:\\r?\\n)?${escapeRegExp(HOOK_START)}[\\s\\S]*?${escapeRegExp(HOOK_END)}(?:\\r?\\n)?`, 'm');

export function stripManagedBlock(content) {
  const text = String(content || '');
  if (!text.includes(HOOK_START) || !text.includes(HOOK_END)) return text;
  return text.replace(HOOK_BLOCK_RE, (match) => {
    // Preserve a single newline boundary when block sat between two sections.
    return match.startsWith('\n') && match.endsWith('\n') ? '\n' : '';
  });
}

export function hasManagedBlock(content) {
  const text = String(content || '');
  return text.includes(HOOK_START) && text.includes(HOOK_END);
}

export function hasCustomAgyDefinition(content, shell) {
  const withoutManaged = stripManagedBlock(content);
  const lines = withoutManaged.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (shell === 'fish') {
      if (/^(?:function\s+agy(?:\s|$)|alias\s+agy(?:=|\s|$)|abbr\s+.*?\bagy\b)/.test(line)) return true;
    } else if (shell === 'pwsh') {
      if (/^(?:function\s+agy\b|Set-Alias\s+(?:-Name\s+)?agy\b|sal\s+agy\b)/i.test(line)) return true;
    } else {
      if (/^(?:alias\s+agy=|function\s+agy\b|agy\s*\(\s*\))/.test(line)) return true;
    }
  }
  return false;
}

export function installShellHook({ home = homedir(), shell = null, platform = process.platform, env = process.env } = {}) {
  const resolved = resolveShellRcPath({ home, shell, platform, env });
  const { rcPath, reloadCmd } = resolved;
  const chosenShell = resolved.shell;
  const block = buildShellHookBlock(chosenShell);
  const eol = chosenShell === 'pwsh' ? '\r\n' : '\n';

  const existing = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';

  if (hasManagedBlock(existing)) {
    const updatedContent = existing.replace(
      new RegExp(`${escapeRegExp(HOOK_START)}[\\s\\S]*?${escapeRegExp(HOOK_END)}`, 'm'),
      block,
    );
    if (updatedContent !== existing) {
      writeFileSync(rcPath, updatedContent, 'utf8');
    }
    return {
      installed: true,
      updated: true,
      skipped: false,
      shell: chosenShell,
      rcPath,
      reloadCmd,
      warning: null,
    };
  }

  if (hasCustomAgyDefinition(existing, chosenShell)) {
    return {
      installed: false,
      updated: false,
      skipped: true,
      shell: chosenShell,
      rcPath,
      reloadCmd,
      warning: `Skipped shell hook in ${rcPath} because a custom "agy" alias/function already exists there.`,
    };
  }

  mkdirSync(dirname(rcPath), { recursive: true });
  const trimmedEnd = existing.replace(/[\r\n]+$/, '');
  const nextContent = trimmedEnd ? `${trimmedEnd}${eol}${eol}${block}${eol}` : `${block}${eol}`;
  writeFileSync(rcPath, nextContent, 'utf8');

  return {
    installed: true,
    updated: false,
    skipped: false,
    shell: chosenShell,
    rcPath,
    reloadCmd,
    warning: null,
  };
}

export function uninstallShellHook({ home = homedir(), shell = null, platform = process.platform, env = process.env } = {}) {
  const candidates = shell
    ? [resolveShellRcPath({ home, shell, platform, env }).rcPath]
    : [
        resolveShellRcPath({ home, shell: 'zsh', platform, env }).rcPath,
        join(home, '.bashrc'),
        join(home, '.bash_profile'),
        join(home, '.config', 'fish', 'config.fish'),
        join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
        join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      ];

  const removedPaths = [];
  const seen = new Set();
  for (const rcPath of candidates) {
    if (seen.has(rcPath)) continue;
    seen.add(rcPath);
    if (!existsSync(rcPath)) continue;
    const existing = readFileSync(rcPath, 'utf8');
    if (!hasManagedBlock(existing)) continue;

    const stripped = stripManagedBlock(existing).replace(/(\r?\n){3,}/g, '\n\n');
    const cleaned = stripped.trim() ? `${stripped.replace(/[\r\n]+$/, '')}\n` : '';
    writeFileSync(rcPath, cleaned, 'utf8');
    removedPaths.push(rcPath);
  }

  return {
    removed: removedPaths.length > 0,
    rcPaths: removedPaths,
  };
}

export function inspectShellHook({ home = homedir(), shell = null, platform = process.platform, env = process.env } = {}) {
  const resolved = resolveShellRcPath({ home, shell, platform, env });
  const installed = existsSync(resolved.rcPath) && hasManagedBlock(readFileSync(resolved.rcPath, 'utf8'));
  return {
    installed,
    shell: resolved.shell,
    rcPath: resolved.rcPath,
    reloadCmd: resolved.reloadCmd,
  };
}

export function formatShellHookPrompt({ rcPath }) {
  return [
    '',
    `Optional: No-TUN proxy shell hook (${rcPath})`,
    '  Adds a 7-line managed agy() function so typing plain "agy" automatically',
    '  uses your local proxy (Clash/Surge/v2ray) without enabling TUN mode.',
    '  • Never modifies the agy binary; stays silent when no local proxy is running.',
    '  • Removable anytime via "agy-bar proxy unhook" or "agy-bar uninstall".',
    `  • If you skip this, ${rcPath} stays untouched (you can still use "agy-bar run").`,
    '',
  ].join('\n');
}

export async function resolveInstallShellHookChoice({
  flagValue = undefined,
  withShim = true,
  alreadyInstalled = false,
  isInteractive = false,
  yes = false,
  promptFn = null,
} = {}) {
  if (!withShim) return { enable: false, reason: 'no-shim' };
  if (typeof flagValue === 'boolean') return { enable: flagValue, reason: 'flag' };
  if (alreadyInstalled) return { enable: true, reason: 'preserved' };
  if (isInteractive && !yes && typeof promptFn === 'function') {
    const accepted = Boolean(await promptFn());
    return { enable: accepted, reason: accepted ? 'prompt-yes' : 'prompt-no' };
  }
  return { enable: false, reason: 'non-interactive-default' };
}

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir, configPath, DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig } from './config.mjs';
import { SAMPLE_PAYLOADS } from './preview.mjs';
import { redactProxyUrl } from './proxy.mjs';
import { renderStatusline } from './render.mjs';
import { inspectShellHook, installShellHook, uninstallShellHook } from './shell-hook.mjs';
import { installSkill, targetSkillPath, uninstallSkill } from './skill.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MANAGED_SHIM_MARKER = 'agy-bar: managed shim';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function agySettingsPath(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

export function installedAppDir(home = homedir()) {
  return join(configDir(home), 'app');
}

export function installedScriptPath(home = homedir()) {
  return join(installedAppDir(home), 'src', 'statusline.mjs');
}

export function installedTitleScriptPath(home = homedir()) {
  return join(installedAppDir(home), 'src', 'title.mjs');
}

export function installedCliPath(home = homedir()) {
  return join(installedAppDir(home), 'bin', 'agy-bar.mjs');
}

export function cliShimPath(home = homedir(), platform = process.platform) {
  return join(home, '.local', 'bin', platform === 'win32' ? 'agy-bar.cmd' : 'agy-bar');
}

export function backupFilePath(home = homedir()) {
  return join(configDir(home), 'previous-statusline.json');
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function buildCommand(executable, scriptPath, platform = process.platform, exportName = 'runStatusline') {
  if (platform === 'win32') {
    // Avoid spaces, quotes, and '>' redirection operators for Windows cmd /c safety.
    const encodedUrl = Buffer.from(pathToFileURL(scriptPath).href).toString('base64');
    return `node -e import(Buffer.from('${encodedUrl}','base64').toString()).then(function(m){m.${exportName}()})`;
  }
  return `${shQuote(executable)} ${shQuote(scriptPath)}`;
}

export function buildCliShim(executable, cliPath, platform = process.platform) {
  if (platform === 'win32') {
    return `@echo off\r\nREM ${MANAGED_SHIM_MARKER}\r\n"${executable}" "${cliPath}" %*\r\n`;
  }
  return `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\nexec ${shQuote(executable)} ${shQuote(cliPath)} "$@"\n`;
}

export function installCliShim({ home = homedir(), executable, cliPath = installedCliPath(home), platform = process.platform } = {}) {
  const dest = cliShimPath(home, platform);
  if (existsSync(dest)) {
    const existing = readFileSync(dest, 'utf8');
    if (!existing.includes(MANAGED_SHIM_MARKER)) {
      return {
        shimPath: null,
        shimWarning: `Skipped installing CLI shim at ${dest} because an unrelated file already exists there.`,
      };
    }
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buildCliShim(executable, cliPath, platform), 'utf8');
  if (platform !== 'win32') {
    chmodSync(dest, 0o755);
  }
  return { shimPath: dest, shimWarning: null };
}

export function uninstallCliShim({ home = homedir(), platform = process.platform } = {}) {
  const dest = cliShimPath(home, platform);
  if (!existsSync(dest)) return false;
  try {
    const content = readFileSync(dest, 'utf8');
    if (!content.includes(MANAGED_SHIM_MARKER)) return false;
    rmSync(dest, { force: true });
    return true;
  } catch {
    return false;
  }
}

function normalizeDirPath(p, platform = process.platform) {
  let target;
  try {
    target = realpathSync(p);
  } catch {
    target = resolve(p);
  }
  return platform === 'win32' ? target.toLowerCase() : target;
}

export function isAgyBarCommand(command, backup = null) {
  if (typeof command !== 'string' || !command.trim()) return false;
  if (command.includes('agy-bar')) return true;
  if (backup?.installedCommand && command === backup.installedCommand) return true;
  if (backup?.installedTitleCommand && command === backup.installedTitleCommand) return true;

  // Windows buildCommand() base64-encodes the file:// URL for cmd /c safety.
  const b64Match = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(command);
  if (b64Match) {
    try {
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf8');
      if (decoded.includes('agy-bar')) return true;
    } catch {
      // Ignore malformed base64.
    }
  }
  return false;
}

function copyRuntimeFiles(sourceRoot, destAppDir, platform = process.platform) {
  // Never wipe destAppDir when re-running `agy-bar install` from the installed runtime itself.
  if (normalizeDirPath(sourceRoot, platform) === normalizeDirPath(destAppDir, platform)) {
    return;
  }

  rmSync(destAppDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  mkdirSync(join(destAppDir, 'src'), { recursive: true });
  mkdirSync(join(destAppDir, 'bin'), { recursive: true });

  copyFileSync(join(sourceRoot, 'package.json'), join(destAppDir, 'package.json'));
  copyFileSync(join(sourceRoot, 'bin', 'agy-bar.mjs'), join(destAppDir, 'bin', 'agy-bar.mjs'));

  for (const entry of readdirSync(join(sourceRoot, 'src'))) {
    if (entry.endsWith('.mjs')) {
      copyFileSync(join(sourceRoot, 'src', entry), join(destAppDir, 'src', entry));
    }
  }

  const skillSource = join(sourceRoot, 'skills', 'agy-bar', 'SKILL.md');
  if (existsSync(skillSource)) {
    mkdirSync(join(destAppDir, 'skills', 'agy-bar'), { recursive: true });
    copyFileSync(skillSource, join(destAppDir, 'skills', 'agy-bar', 'SKILL.md'));
  }
}

export function installAgyBar({
  home = homedir(),
  executable = realpathSync(process.execPath),
  platform = process.platform,
  env = process.env,
  withSkill = true,
  withShim = true,
  withTitle = true,
  withShellHook = false,
  shell = null,
  preset = null,
  theme = null,
  barStyle = null,
  sourceRoot = PACKAGE_ROOT,
} = {}) {
  let skillDest = null;
  if (withSkill) {
    const skillSource = join(sourceRoot, 'skills', 'agy-bar', 'SKILL.md');
    if (existsSync(skillSource)) {
      skillDest = installSkill({ home, sourcePath: skillSource });
    }
  }

  const appDir = installedAppDir(home);
  const scriptPath = installedScriptPath(home);
  const titleScriptPath = installedTitleScriptPath(home);
  const cliPath = installedCliPath(home);
  const settingsPath = agySettingsPath(home);
  const backupPath = backupFilePath(home);
  const cfgPath = configPath(home);

  copyRuntimeFiles(sourceRoot, appDir, platform);

  let shimPath = null;
  let shimWarning = null;
  if (withShim) {
    const shimRes = installCliShim({ home, executable, cliPath, platform });
    shimPath = shimRes.shimPath;
    shimWarning = shimRes.shimWarning;
  }

  let shellHook = null;
  if (withShellHook && withShim) {
    shellHook = installShellHook({ home, shell, platform, env });
  }

  // Initialize or update user config while preserving prior overrides.
  const existingCfg = existsSync(cfgPath) ? loadConfig(cfgPath) : { ...DEFAULT_CONFIG, show: { ...DEFAULT_CONFIG.show } };
  if (preset && preset !== existingCfg.preset) {
    existingCfg.preset = preset;
    if (PRESETS[preset]) existingCfg.show = { ...PRESETS[preset] };
  }
  if (theme) existingCfg.theme = theme;
  if (barStyle) existingCfg.barStyle = barStyle;
  const savedConfig = saveConfig(existingCfg, cfgPath);

  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
  const existingBackup = existsSync(backupPath) ? readJson(backupPath) : null;
  const command = buildCommand(executable, scriptPath, platform, 'runStatusline');
  const titleCommand = buildCommand(executable, titleScriptPath, platform, 'runTitleCommand');

  const existingTitleOurs = Boolean(
    settings.title &&
      (settings.title?.command === existingBackup?.installedTitleCommand ||
        isAgyBarCommand(settings.title?.command, existingBackup)),
  );
  const hasUnrelatedTitle = Boolean(settings.title && !existingTitleOurs);
  let titleInstalled = false;
  let titleWarning = null;

  // Keep the original backup across upgrades unless the user switched away to another renderer.
  const statusLineBackup =
    existingBackup && settings.statusLine?.command === existingBackup.installedCommand
      ? {
          hadStatusLine: existingBackup.hadStatusLine,
          statusLine: existingBackup.statusLine,
          installedCommand: command,
        }
      : {
          hadStatusLine: Object.hasOwn(settings, 'statusLine'),
          statusLine: settings.statusLine ?? null,
          installedCommand: command,
        };

  let titleBackup;
  if (existingBackup && Object.hasOwn(existingBackup, 'hadTitle') && existingTitleOurs) {
    titleBackup = {
      hadTitle: existingBackup.hadTitle,
      title: existingBackup.title,
      installedTitleCommand: withTitle ? titleCommand : existingBackup.installedTitleCommand ?? null,
    };
  } else if (withTitle && !hasUnrelatedTitle) {
    titleBackup = {
      hadTitle: Object.hasOwn(settings, 'title'),
      title: settings.title ?? null,
      installedTitleCommand: titleCommand,
    };
  } else if (existingBackup && Object.hasOwn(existingBackup, 'hadTitle')) {
    titleBackup = {
      hadTitle: existingBackup.hadTitle,
      title: existingBackup.title,
      installedTitleCommand: existingBackup.installedTitleCommand ?? null,
    };
  } else {
    titleBackup = {};
  }

  writeJson(backupPath, { ...statusLineBackup, ...titleBackup });

  settings.statusLine = {
    type: 'command',
    command,
    enabled: true,
    stack_with_default: false,
  };

  if (withTitle) {
    if (hasUnrelatedTitle) {
      titleWarning = 'Kept existing custom AGY title command in settings.json (pass --no-title to silence this note).';
    } else {
      settings.title = {
        type: 'command',
        command: titleCommand,
        enabled: savedConfig.tabTitle !== false,
      };
      titleInstalled = true;
    }
  }

  writeJson(settingsPath, settings);

  return {
    installed: true,
    scriptPath,
    titleScriptPath: titleInstalled ? titleScriptPath : null,
    titleCommand: titleInstalled ? titleCommand : null,
    titleWarning,
    cliPath,
    shimPath,
    shimWarning,
    shellHook,
    settingsPath,
    configPath: cfgPath,
    skillPath: skillDest,
    command,
    config: savedConfig,
  };
}

export function uninstallAgyBar({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  removeSkill = false,
  purge = false,
} = {}) {
  const settingsPath = agySettingsPath(home);
  const backupPath = backupFilePath(home);
  const appDir = installedAppDir(home);
  const cfgDir = configDir(home);

  const hadBackup = existsSync(backupPath);
  const hadApp = existsSync(appDir);
  const hadCfgDir = existsSync(cfgDir);
  let restored = false;
  let titleRestored = false;

  if (hadBackup) {
    const backup = readJson(backupPath);
    if (existsSync(settingsPath)) {
      const settings = readJson(settingsPath);
      let settingsChanged = false;
      if (settings.statusLine?.command === backup.installedCommand) {
        if (backup.hadStatusLine) {
          settings.statusLine = backup.statusLine;
        } else {
          delete settings.statusLine;
        }
        restored = true;
        settingsChanged = true;
      }
      if (
        backup.installedTitleCommand &&
        (settings.title?.command === backup.installedTitleCommand || isAgyBarCommand(settings.title?.command, backup))
      ) {
        if (backup.hadTitle) {
          settings.title = backup.title;
        } else {
          delete settings.title;
        }
        titleRestored = true;
        settingsChanged = true;
      }
      if (settingsChanged) {
        writeJson(settingsPath, settings);
      }
    }
    rmSync(backupPath, { force: true, maxRetries: 3, retryDelay: 50 });
  } else if (existsSync(settingsPath)) {
    try {
      const settings = readJson(settingsPath);
      if (isAgyBarCommand(settings.title?.command)) {
        delete settings.title;
        writeJson(settingsPath, settings);
        titleRestored = true;
      }
    } catch {
      // Ignore malformed settings.json during orphan cleanup.
    }
  }

  const shimRemoved = uninstallCliShim({ home, platform });
  const hookResult = uninstallShellHook({ home, platform, env });
  if (hadApp) {
    rmSync(appDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  let skillResult = null;
  if (removeSkill) {
    skillResult = uninstallSkill({ home });
  }

  if (purge && hadCfgDir) {
    rmSync(cfgDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  const removedAnything = Boolean(
    hadBackup || hadApp || shimRemoved || hookResult.removed || skillResult?.removed || titleRestored || (purge && hadCfgDir),
  );
  if (!removedAnything) {
    return {
      uninstalled: false,
      restored: false,
      titleRestored: false,
      shimRemoved: false,
      shellHookRemoved: false,
      shellHookPaths: [],
      skillRemoved: false,
      purged: false,
      message: 'agy-bar is not currently installed.',
    };
  }

  return {
    uninstalled: true,
    restored,
    titleRestored,
    shimRemoved,
    shellHookRemoved: hookResult.removed,
    shellHookPaths: hookResult.rcPaths,
    skillRemoved: Boolean(skillResult?.removed),
    purged: purge && hadCfgDir,
    message: restored
      ? 'Removed agy-bar and restored your previous statusLine setting. Restart agy.'
      : hadBackup
        ? 'Removed agy-bar files (kept your current statusLine since it pointed to another renderer). Restart agy.'
        : 'Cleaned up remaining agy-bar files and shell hooks.',
  };
}

export function runDoctor({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  const settingsPath = agySettingsPath(home);
  const scriptPath = installedScriptPath(home);
  const titleScriptPath = installedTitleScriptPath(home);
  const shimDest = cliShimPath(home, platform);
  const cfgPath = configPath(home);
  const skillPath = targetSkillPath(home);

  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js >= 20',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}`,
  });

  const runtimeExists = existsSync(scriptPath);
  checks.push({
    name: 'Runtime installed',
    ok: runtimeExists,
    detail: runtimeExists ? scriptPath : `Not found (${scriptPath})`,
  });

  const shimExists = existsSync(shimDest);
  checks.push({
    name: 'CLI shim (agy-bar)',
    ok: shimExists,
    optional: true,
    detail: shimExists ? shimDest : `Not installed (run "install" to create ${shimDest})`,
  });

  const hookInfo = inspectShellHook({ home, platform, env });
  checks.push({
    name: 'Shell hook (plain "agy")',
    ok: hookInfo.installed,
    optional: true,
    detail: hookInfo.installed
      ? `${hookInfo.rcPath} (plain "agy" auto-uses local proxy without TUN)`
      : `Not installed in ${hookInfo.rcPath} (optional — run "agy-bar proxy hook")`,
  });

  let statusLineEnabled = false;
  let settingsDetail = 'settings.json not found';
  let nativeTitleActive = false;
  let nativeTitleDetail = 'not configured (run "agy-bar install" to enable native cross-platform tab titles)';
  let backup = null;
  const backupPath = backupFilePath(home);
  if (existsSync(backupPath)) {
    try {
      backup = readJson(backupPath);
    } catch {
      backup = null;
    }
  }
  if (existsSync(settingsPath)) {
    try {
      const settings = readJson(settingsPath);
      statusLineEnabled =
        settings.statusLine?.enabled === true &&
        isAgyBarCommand(settings.statusLine?.command, backup);
      settingsDetail = statusLineEnabled
        ? 'statusLine.enabled = true (agy-bar active)'
        : settings.statusLine
          ? `statusLine points to another command (${settings.statusLine.command || 'unknown'})`
          : 'statusLine not configured';

      const titleIsOurs = isAgyBarCommand(settings.title?.command, backup);
      nativeTitleActive = settings.title?.enabled === true && titleIsOurs && existsSync(titleScriptPath);
      nativeTitleDetail = nativeTitleActive
        ? 'title.enabled = true (agy-bar native title active — macOS/Linux/Windows)'
        : titleIsOurs && settings.title?.enabled === false
          ? 'title.enabled = false (disabled in settings.json; run "/title on" in agy)'
          : settings.title
            ? `title points to another command (${settings.title.command || 'unknown'})`
            : nativeTitleDetail;
    } catch (err) {
      settingsDetail = `Failed to parse settings.json: ${err.message}`;
    }
  }
  checks.push({
    name: 'AGY settings.json',
    ok: statusLineEnabled,
    detail: settingsDetail,
  });
  checks.push({
    name: 'AGY native title',
    ok: nativeTitleActive,
    optional: true,
    detail: nativeTitleDetail,
  });

  const skillInstalled = existsSync(skillPath);
  checks.push({
    name: 'Companion /agy-bar skill',
    ok: skillInstalled,
    optional: true,
    detail: skillInstalled ? skillPath : 'Not installed (optional)',
  });

  const cfg = loadConfig(cfgPath);
  const proxyDetail =
    cfg.proxy.mode === 'off'
      ? 'disabled (mode=off)'
      : cfg.proxy.mode === 'manual' && cfg.proxy.url
        ? `mode=manual · ${redactProxyUrl(cfg.proxy.url)} (run "agy-bar proxy" to test)`
        : 'mode=auto (auto-detects local proxy on "agy-bar run")';
  checks.push({
    name: 'No-TUN proxy launcher',
    ok: true,
    optional: true,
    detail: proxyDetail,
  });

  const sampleOutput = renderStatusline(SAMPLE_PAYLOADS.normal, {
    config: cfg,
    color: false,
    git: { branch: 'main', dirty: true },
  });
  checks.push({
    name: 'Render self-test',
    ok: sampleOutput.includes('CTX') && sampleOutput.includes('5h'),
    detail: sampleOutput.replace(/\n/g, ' ↵ '),
  });

  return {
    ok: checks.every((c) => c.ok || c.optional),
    checks,
  };
}

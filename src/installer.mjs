import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir, configPath, DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig } from './config.mjs';
import { SAMPLE_PAYLOADS } from './preview.mjs';
import { renderStatusline } from './render.mjs';
import { installSkill, targetSkillPath, uninstallSkill } from './skill.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

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

export function backupFilePath(home = homedir()) {
  return join(configDir(home), 'previous-statusline.json');
}

export function buildCommand(executable, scriptPath, platform = process.platform) {
  if (platform === 'win32') {
    // Avoid spaces, quotes, and '>' redirection operators for Windows cmd /c safety.
    const encodedUrl = Buffer.from(pathToFileURL(scriptPath).href).toString('base64');
    return `node -e import(Buffer.from('${encodedUrl}','base64').toString()).then(function(m){m.runStatusline()})`;
  }
  const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `${shQuote(executable)} ${shQuote(scriptPath)}`;
}

function copyRuntimeFiles(sourceRoot, destAppDir) {
  rmSync(destAppDir, { recursive: true, force: true });
  mkdirSync(join(destAppDir, 'src'), { recursive: true });
  mkdirSync(join(destAppDir, 'bin'), { recursive: true });

  copyFileSync(join(sourceRoot, 'package.json'), join(destAppDir, 'package.json'));
  copyFileSync(join(sourceRoot, 'bin', 'agy-bar.mjs'), join(destAppDir, 'bin', 'agy-bar.mjs'));

  for (const entry of readdirSync(join(sourceRoot, 'src'))) {
    if (entry.endsWith('.mjs')) {
      copyFileSync(join(sourceRoot, 'src', entry), join(destAppDir, 'src', entry));
    }
  }
}

export function installAgyBar({
  home = homedir(),
  executable = realpathSync(process.execPath),
  platform = process.platform,
  withSkill = true,
  preset = null,
  theme = null,
  barStyle = null,
  sourceRoot = PACKAGE_ROOT,
} = {}) {
  let skillDest = null;
  if (withSkill) {
    skillDest = installSkill({ home, sourcePath: join(sourceRoot, 'skills', 'agy-bar', 'SKILL.md') });
  }

  const appDir = installedAppDir(home);
  const scriptPath = installedScriptPath(home);
  const settingsPath = agySettingsPath(home);
  const backupPath = backupFilePath(home);
  const cfgPath = configPath(home);

  copyRuntimeFiles(sourceRoot, appDir);

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
  const command = buildCommand(executable, scriptPath, platform);

  // Keep the original backup across upgrades unless the user switched away to another renderer.
  const backup =
    existingBackup && settings.statusLine?.command === existingBackup.installedCommand
      ? { ...existingBackup, installedCommand: command }
      : {
          hadStatusLine: Object.hasOwn(settings, 'statusLine'),
          statusLine: settings.statusLine ?? null,
          installedCommand: command,
        };

  writeJson(backupPath, backup);

  settings.statusLine = {
    type: 'command',
    command,
    enabled: true,
    stack_with_default: false,
  };
  writeJson(settingsPath, settings);

  return {
    installed: true,
    scriptPath,
    settingsPath,
    configPath: cfgPath,
    skillPath: skillDest,
    command,
    config: savedConfig,
  };
}

export function uninstallAgyBar({ home = homedir(), removeSkill = false, purge = false } = {}) {
  const settingsPath = agySettingsPath(home);
  const backupPath = backupFilePath(home);
  const appDir = installedAppDir(home);

  if (!existsSync(backupPath)) {
    return {
      uninstalled: false,
      message: 'agy-bar is not currently installed.',
    };
  }

  const backup = readJson(backupPath);
  let restored = false;

  if (existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    if (settings.statusLine?.command === backup.installedCommand) {
      if (backup.hadStatusLine) {
        settings.statusLine = backup.statusLine;
      } else {
        delete settings.statusLine;
      }
      writeJson(settingsPath, settings);
      restored = true;
    }
  }

  rmSync(appDir, { recursive: true, force: true });
  rmSync(backupPath, { force: true });

  let skillResult = null;
  if (removeSkill) {
    skillResult = uninstallSkill({ home });
  }

  if (purge) {
    rmSync(configDir(home), { recursive: true, force: true });
  }

  return {
    uninstalled: true,
    restored,
    skillRemoved: Boolean(skillResult?.removed),
    purged: purge,
    message: restored
      ? 'Removed agy-bar and restored your previous statusLine setting. Restart agy.'
      : 'Removed agy-bar files (kept your current statusLine since it pointed to another renderer). Restart agy.',
  };
}

export function runDoctor({ home = homedir() } = {}) {
  const settingsPath = agySettingsPath(home);
  const scriptPath = installedScriptPath(home);
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

  let statusLineEnabled = false;
  let settingsDetail = 'settings.json not found';
  if (existsSync(settingsPath)) {
    try {
      const settings = readJson(settingsPath);
      statusLineEnabled =
        settings.statusLine?.enabled === true &&
        typeof settings.statusLine?.command === 'string' &&
        settings.statusLine.command.includes('agy-bar');
      settingsDetail = statusLineEnabled
        ? 'statusLine.enabled = true (agy-bar active)'
        : settings.statusLine
          ? `statusLine points to another command (${settings.statusLine.command || 'unknown'})`
          : 'statusLine not configured';
    } catch (err) {
      settingsDetail = `Failed to parse settings.json: ${err.message}`;
    }
  }
  checks.push({
    name: 'AGY settings.json',
    ok: statusLineEnabled,
    detail: settingsDetail,
  });

  const skillInstalled = existsSync(skillPath);
  checks.push({
    name: 'Companion /agy-bar skill',
    ok: skillInstalled,
    detail: skillInstalled ? skillPath : 'Not installed (optional)',
  });

  const cfg = loadConfig(cfgPath);
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
    ok: checks.every((c) => c.ok || c.name.includes('skill')),
    checks,
  };
}

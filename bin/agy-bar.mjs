#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyConfigCommand, BAR_STYLE_NAMES, PRESET_NAMES } from '../src/config.mjs';
import { installAgyBar, runDoctor, uninstallAgyBar } from '../src/installer.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import { runStatusline } from '../src/statusline.mjs';
import { THEME_NAMES } from '../src/themes.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

export const HELP_TEXT = [
  `agy-bar v${pkg.version} — Modern minimal dashboard statusline for Antigravity CLI (agy)`,
  '',
  'Usage: agy-bar <command> [options]',
  '',
  'Commands:',
  '  install [options]       Install statusline into ~/.gemini/antigravity-cli/settings.json',
  '    --no-skill            Skip installing the companion /agy-bar skill',
  `    --preset <name>       Initial preset (${PRESET_NAMES.join(' | ')})`,
  `    --theme <name>        Initial theme (${THEME_NAMES.join(' | ')})`,
  `    --bar-style <style>   Gauge style (${BAR_STYLE_NAMES.join(' | ')})`,
  '',
  '  uninstall [options]     Remove agy-bar and restore previous statusLine setting',
  '    --remove-skill        Also remove the managed /agy-bar skill',
  '    --purge               Also remove ~/.gemini/config/agy-bar/config.json',
  '',
  '  config <subcommand>     Inspect or update display preferences',
  '    show                  Print effective configuration as JSON',
  `    preset <name>         Switch layout preset (${PRESET_NAMES.join(' | ')})`,
  `    theme <name>          Switch theme (${THEME_NAMES.join(' | ')})`,
  `    bar-style <style>     Switch bar style (${BAR_STYLE_NAMES.join(' | ')})`,
  '    enable <items...>     Enable specific items (git, cache, capacity, reset, ...)',
  '    disable <items...>    Disable specific items',
  '    set <key> <value>...  Set barWidth, thresholds, or show.<item> on|off',
  '    reset                 Restore default settings',
  '',
  '  preview [options]       Render live sample statuslines in your terminal',
  '    --scenario <name>     normal | warning | critical | claude | all (default: normal)',
  '    --width <cols>        Simulated terminal width (default: 100)',
  '    --preset <name>       Override preset for preview',
  '    --theme <name>        Override theme for preview',
  '    --bar-style <style>   Override gauge style for preview',
  '    --plain               Disable ANSI colors',
  '',
  '  doctor                  Verify installation, Node version, and run a self-test',
  '  render                  Read AGY JSON payload from stdin and render to stdout',
].join('\n');

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-skill') flags.withSkill = false;
    else if (arg === '--with-skill') flags.withSkill = true;
    else if (arg === '--remove-skill') flags.removeSkill = true;
    else if (arg === '--purge') flags.purge = true;
    else if (arg === '--plain') flags.plain = true;
    else if (['--preset', '--theme', '--bar-style', '--scenario', '--width'].includes(arg)) {
      const value = args[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP_TEXT);
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(pkg.version);
    return;
  }

  if (command === 'render') {
    await runStatusline({ argv: rest });
    return;
  }

  if (command === 'install') {
    const { flags } = parseFlags(rest);
    const result = installAgyBar({
      withSkill: flags.withSkill ?? true,
      preset: flags.preset ?? null,
      theme: flags.theme ?? null,
      barStyle: flags.barStyle ?? null,
    });
    console.log(`Installed agy-bar statusline at ${result.scriptPath}`);
    console.log(`Updated AGY settings: ${result.settingsPath}`);
    if (result.skillPath) {
      console.log(`Installed companion /agy-bar skill: ${result.skillPath}`);
    }
    console.log('Restart agy to activate the new statusline (or run /skills reload in an existing session for /agy-bar).');
    return;
  }

  if (command === 'uninstall') {
    const { flags } = parseFlags(rest);
    const result = uninstallAgyBar({
      removeSkill: Boolean(flags.removeSkill),
      purge: Boolean(flags.purge),
    });
    console.log(result.message);
    return;
  }

  if (command === 'config') {
    const result = applyConfigCommand(rest);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'preview') {
    const { flags } = parseFlags(rest);
    const width = flags.width ? Number(flags.width) : 100;
    if (!Number.isFinite(width) || width < 20 || width > 300) {
      throw new Error('--width must be a number between 20 and 300.');
    }
    const output = buildPreviewOutput({
      scenario: flags.scenario || 'normal',
      width,
      preset: flags.preset || null,
      theme: flags.theme || null,
      barStyle: flags.barStyle || null,
      color: !flags.plain && !('NO_COLOR' in process.env),
    });
    console.log(output);
    return;
  }

  if (command === 'doctor') {
    const report = runDoctor();
    for (const check of report.checks) {
      const icon = check.ok ? '✓' : '✗';
      console.log(`${icon} ${check.name}: ${check.detail}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command "${command}". Run "agy-bar --help" for usage.`);
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
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

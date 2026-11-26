#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyConfigCommand, BAR_STYLE_NAMES, COLOR_MODES, loadConfig, PRESET_NAMES, TAB_TITLE_SOURCES } from '../src/config.mjs';
import { installAgyBar, runDoctor, uninstallAgyBar } from '../src/installer.mjs';
import { startMonitor } from '../src/monitor.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import { detectModelGroup, selectQuotaEntries } from '../src/render.mjs';
import { aggregateStats, formatStatsReport, PERIOD_NAMES, readLedger } from '../src/stats.mjs';
import { runStatusline } from '../src/statusline.mjs';
import { buildTabTitle, writeOscTitle } from '../src/tab-title.mjs';
import { armPayloadCapture, listSessions, readCapturedPayload, setSessionCustomTitle, updateSessionTabTitle } from '../src/telemetry.mjs';
import { THEME_NAMES } from '../src/themes.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

export const HELP_TEXT = [
  `agy-bar v${pkg.version} — Modern minimal dashboard statusline & CLI HUD for Antigravity CLI (agy)`,
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
  '    --purge               Also remove ~/.gemini/config/agy-bar/config.json & telemetry',
  '',
  '  config <subcommand>     Inspect or update display preferences',
  '    show                  Print effective configuration as JSON',
  `    preset <name>         Switch layout preset (${PRESET_NAMES.join(' | ')})`,
  `    theme <name>          Switch theme (${THEME_NAMES.join(' | ')})`,
  `    bar-style <style>     Switch bar style (${BAR_STYLE_NAMES.join(' | ')})`,
  '    enable <items...>     Enable items (ttft, speed, dir, vim, cost, session, contextDelta, ...)',
  '    disable <items...>    Disable items',
  `    set <key> <value>...  Set colorMode (${COLOR_MODES.join('|')}), barWidth, ttftWarnSec, dbTiming, ledger`,
  '    reset                 Restore default settings',
  '',
  '  stats [period] [opts]   Show local CLI token usage, cache savings & estimated API cost',
  `    period                ${PERIOD_NAMES.join(' | ')} (default: 7d)`,
  '    --model <filter>      Filter by model substring (e.g. claude, carbon, neon)',
  '    --json                Output machine-readable JSON',
  '    --plain               Disable ANSI colors',
  '',
  '  monitor [options]       Live multi-CLI HUD tracking all active agy terminals',
  '    --interval <ms>       Refresh interval in milliseconds (default: 1000)',
  '    --once                Print a single snapshot and exit',
  '    --plain               Disable ANSI colors',
  '',
  '  title [text] [options]  Set or inspect the terminal tab title for the current session',
  '    --session <id>        Target a specific session ID (defaults to most recent active)',
  '    --clear               Clear custom title and revert to AGY conversation_title',
  `    (configure with: config set tabTitle on|off tabTitleSource ${TAB_TITLE_SOURCES.join('|')})`,
  '',
  '  debug [options]         Capture or inspect a PII-redacted AGY statusLine JSON payload',
  '    --capture             Arm one-shot capture on the next AGY statusline refresh',
  '    --show                Display the last captured redacted payload (default)',
  '',
  '  preview [options]       Render live sample statuslines in your terminal',
  '    --scenario <name>     normal | warning | critical | claude | all (default: normal)',
  '    --width <cols>        Simulated terminal width (default: 116)',
  '    --preset <name>       Override preset for preview',
  '    --theme <name>        Override theme for preview',
  `    --color-mode <mode>   Override colorMode (${COLOR_MODES.join(' | ')})`,
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
    else if (arg === '--json') flags.json = true;
    else if (arg === '--once') flags.once = true;
    else if (arg === '--capture') flags.capture = true;
    else if (arg === '--show') flags.show = true;
    else if (arg === '--clear') flags.clear = true;
    else if (['--preset', '--theme', '--bar-style', '--color-mode', '--scenario', '--width', '--model', '--interval', '--session'].includes(arg)) {
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

  if (command === 'stats') {
    const { flags, positional } = parseFlags(rest);
    const period = positional[0] || '7d';
    const entries = readLedger();
    const report = aggregateStats(entries, { period, modelFilter: flags.model || null });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const cfg = loadConfig();
    const color = !flags.plain && !('NO_COLOR' in process.env) && cfg.theme !== 'mono';
    console.log(formatStatsReport(report, { color, theme: cfg.theme }));
    return;
  }

  if (command === 'monitor') {
    const { flags } = parseFlags(rest);
    const intervalMs = flags.interval ? Number(flags.interval) : 1000;
    if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 60000) {
      throw new Error('--interval must be between 250 and 60000 milliseconds.');
    }
    const cfg = loadConfig();
    const color = !flags.plain && !('NO_COLOR' in process.env) && cfg.theme !== 'mono';
    await startMonitor({ intervalMs, once: Boolean(flags.once), color });
    return;
  }

  if (command === 'title') {
    const { flags, positional } = parseFlags(rest);
    const cfg = loadConfig();
    if (!flags.clear && positional.length === 0) {
      const recent = listSessions();
      const target = flags.session ? recent.find((s) => s.sessionId === flags.session) : recent[0];
      if (!target) {
        console.log('No active agy-bar session found yet.');
        return;
      }
      console.log(
        JSON.stringify(
          {
            sessionId: target.sessionId,
            tabTitleEnabled: cfg.tabTitle,
            source: cfg.tabTitleSource,
            customTitle: target.customTitle || null,
            conversationTitle: target.conversationTitle || null,
            activeTabTitle: target.lastTabTitle || null,
          },
          null,
          2,
        ),
      );
      return;
    }

    const rawText = positional.join(' ').trim();
    const updated = setSessionCustomTitle(rawText, {
      sessionId: flags.session || null,
      clear: Boolean(flags.clear),
    });
    const renderedTitle = buildTabTitle(
      {
        agent_state: updated.agentState,
        conversation_title: updated.conversationTitle,
        cwd: updated.cwd,
      },
      {
        config: cfg,
        git: updated.branch ? { branch: updated.branch, dirty: updated.dirty } : null,
        customTitle: updated.customTitle,
      },
    );
    const writeRes = renderedTitle && cfg.tabTitle ? writeOscTitle(renderedTitle) : { written: false, tty: null };
    if (writeRes.written) {
      updateSessionTabTitle(updated.sessionId, renderedTitle);
    }
    console.log(
      flags.clear
        ? `Cleared custom tab title for session ${updated.sessionId}${renderedTitle ? ` (reverted to "${renderedTitle}")` : ''}.`
        : `Set tab title: ${renderedTitle || updated.customTitle}${writeRes.tty ? ` (${writeRes.tty})` : ''}`,
    );
    return;
  }

  if (command === 'debug') {
    const { flags } = parseFlags(rest);
    if (flags.capture) {
      const armed = armPayloadCapture();
      console.log(`Armed one-shot redacted payload capture.`);
      console.log(`Next time Antigravity CLI refreshes the statusline, a sanitized snapshot will be saved to:`);
      console.log(`  ${armed.target}`);
      console.log(`Run "agy-bar debug" afterward to inspect it.`);
      return;
    }
    const captured = readCapturedPayload();
    if (!captured) {
      console.log('No captured payload found yet. Run "agy-bar debug --capture", wait for one agy refresh, then run "agy-bar debug".');
      return;
    }
    const cfg = loadConfig();
    const p = captured.payload || {};
    const group = detectModelGroup(p.model, p.quota);
    const matchedBuckets = selectQuotaEntries(p.quota, p.model, cfg.show).map((b) => b.id);
    console.log(
      JSON.stringify(
        {
          capturedAt: captured.capturedAt,
          detectedModelGroup: group,
          matchedQuotaBuckets: matchedBuckets,
          payload: p,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'preview') {
    const { flags } = parseFlags(rest);
    const width = flags.width ? Number(flags.width) : 116;
    if (!Number.isFinite(width) || width < 20 || width > 300) {
      throw new Error('--width must be a number between 20 and 300.');
    }
    const output = buildPreviewOutput({
      scenario: flags.scenario || 'normal',
      width,
      preset: flags.preset || null,
      theme: flags.theme || null,
      barStyle: flags.barStyle || null,
      colorMode: flags.colorMode || null,
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

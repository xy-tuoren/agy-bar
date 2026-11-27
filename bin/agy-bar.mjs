#!/usr/bin/env node
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  applyConfigCommand,
  BAR_STYLE_NAMES,
  COLOR_MODES,
  loadConfig,
  PRESET_NAMES,
  saveConfig,
  TAB_TITLE_SOURCES,
} from '../src/config.mjs';
import {
  computeUsageSummary,
  readConversationParentMap,
  saveUsageSummary,
  scanConversationHistory,
  usageSummaryPath,
} from '../src/history-scan.mjs';
import { installAgyBar, runDoctor, uninstallAgyBar } from '../src/installer.mjs';
import { startMonitor } from '../src/monitor.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import {
  BUILTIN_RATES,
  clearPricingMemo,
  lookupRates,
  normalizeModelKey,
  pricingCachePath,
  readPricingCache,
} from '../src/pricing.mjs';
import {
  maybeTriggerBackgroundPricingSync,
  PRICING_SOURCE_NAMES,
  syncPricingCache,
} from '../src/pricing-sync.mjs';
import {
  AGY_BAR_CLEANUP_ENV_VARS,
  checkLocalPort,
  COMMON_LOCAL_PROXY_PORTS,
  DEFAULT_PROXY_BYPASS,
  DEFAULT_PROXY_CONFIG,
  detectLocalProxy,
  formatShellCleanup,
  formatShellExports,
  launchAgyWithProxy,
  normalizeBypassList,
  PROXY_MODES,
  readEnvProxy,
  redactProxyUrl,
  resolveEffectiveProxy,
  validateProxyUrl,
} from '../src/proxy.mjs';
import { detectModelGroup, selectQuotaEntries } from '../src/render.mjs';
import {
  detectShell,
  formatShellHookPrompt,
  inspectShellHook,
  installShellHook,
  resolveInstallShellHookChoice,
  SUPPORTED_SHELLS,
  uninstallShellHook,
} from '../src/shell-hook.mjs';
import { aggregateStats, formatStatsReport, HEATMAP_PALETTE_NAMES, PERIOD_NAMES, readLedger, SOURCE_NAMES } from '../src/stats.mjs';
import { runStatusline } from '../src/statusline.mjs';
import { readConversationSummaryTitle } from '../src/step-timing.mjs';
import { buildTabTitle, resolveTerminalTarget, writeOscTitle } from '../src/tab-title.mjs';
import {
  armPayloadCapture,
  findSessionForHost,
  listSessions,
  readCapturedPayload,
  setSessionCustomTitle,
  updateSessionTabTitle,
} from '../src/telemetry.mjs';
import { THEME_NAMES } from '../src/themes.mjs';
import { isNativeTitleActive } from '../src/title.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

export const HELP_TEXT = [
  `agy-bar v${pkg.version} — Modern minimal dashboard statusline & CLI HUD for Antigravity CLI (agy)`,
  '',
  'Usage: agy-bar <command> [options]',
  '',
  'Commands:',
  '  install [options]       Install statusline + native AGY title hook + global agy-bar CLI',
  '    --proxy-hook          Also install managed agy() shell hook without prompting',
  '    --no-proxy-hook       Skip shell hook without prompting (leaves ~/.zshrc untouched)',
  '    --no-title            Skip configuring AGY native settings.json title hook',
  '    --no-skill            Skip installing the companion /agy-bar skill',
  '    --no-shim             Skip installing the ~/.local/bin/agy-bar shortcut command',
  '    -y, --yes             Non-interactive install (keeps ~/.zshrc untouched unless --proxy-hook)',
  `    --shell <name>        Target shell for the hook (${SUPPORTED_SHELLS.join(' | ')})`,
  `    --preset <name>       Initial preset (${PRESET_NAMES.join(' | ')})`,
  `    --theme <name>        Initial theme (${THEME_NAMES.join(' | ')})`,
  `    --bar-style <style>   Gauge style (${BAR_STYLE_NAMES.join(' | ')})`,
  '',
  '  run [opts] [agy args..] Launch agy through your local proxy without TUN mode',
  '    --proxy <url>         Override proxy URL for this session (e.g. 127.0.0.1:7897)',
  '    --no-proxy            Launch agy directly without proxy environment variables',
  '    --agy-bin <path>      Explicit path to the agy executable',
  '    -q, --quiet           Suppress the one-line launch banner on stderr',
  '    --                    Stop agy-bar option parsing; forward all remaining args to agy',
  '',
  '  proxy [subcommand]      Configure, auto-detect, hook, or test no-TUN proxy settings',
  '    status | check        Show effective proxy, shell hook & live TCP reachability (default)',
  '    auto                  Auto-detect OS or local Clash/Surge/v2ray proxy and save it',
  '    set <url>             Save a manual proxy URL (e.g. http://127.0.0.1:7897)',
  '    on | off              Enable or disable proxy injection without losing saved URL',
  `    mode <mode>           Switch proxy mode (${PROXY_MODES.join(' | ')})`,
  '    hook [--shell <sh>]   Install managed agy() shell hook so plain "agy" uses proxy without TUN',
  '    unhook                Remove the managed agy() shell hook from your shell rc file',
  '    bypass <list|reset>   Set comma-separated NO_PROXY list (always keeps loopback)',
  '    env [--sh|--fish|--pwsh] Print shell export commands (e.g. eval "$(agy-bar proxy env)")',
  '    clear                 Reset proxy settings back to default auto-detect mode',
  '',
  '  uninstall [options]     Remove agy-bar, shell hook & restore previous statusLine setting',
  '    --remove-skill        Also remove the managed /agy-bar skill',
  '    --purge               Also remove ~/.gemini/config/agy-bar/config.json & telemetry',
  '    --print-cleanup       Print shell unset commands for current terminal (use with eval)',
  '',
  '  config <subcommand>     Inspect or update display preferences',
  '    show                  Print effective configuration as JSON',
  `    preset <name>         Switch layout preset (${PRESET_NAMES.join(' | ')})`,
  `    theme <name>          Switch theme (${THEME_NAMES.join(' | ')})`,
  `    bar-style <style>     Switch bar style (${BAR_STYLE_NAMES.join(' | ')})`,
  '    enable <items...>     Enable items (ttft, speed, dir, vim, cost, session, contextDelta, ...)',
  '    disable <items...>    Disable items',
  `    set <key> <value>...  Set colorMode (${COLOR_MODES.join('|')}), dirStyle (short|parent|name), barWidth, ttftWarnSec, dbTiming, pricingAutoSync, ledger`,
  '    reset                 Restore default settings',
  '',
  '  stats [period] [opts]   Full-history token dashboard, terminal heatmap & API cost estimate',
  `    period                ${PERIOD_NAMES.join(' | ')} (default: 7d)`,
  `    --source <src>        ${SOURCE_NAMES.join(' | ')} (default: all — scans CLI + Desktop DBs)`,
  `    --palette <name>      Heatmap ramp: ${HEATMAP_PALETTE_NAMES.join(' | ')} (default: purple)`,
  '    --model <filter>      Filter by model substring (e.g. claude, carbon, neon)',
  '    --no-cache            Force full re-scan of conversation DBs',
  '    --json                Output machine-readable JSON',
  '    --plain               Disable ANSI colors',
  '',
  '  pricing [subcommand]    Inspect, sync, or override local model reference API pricing',
  '    show [--json]         Show cache status and active per-1M token rates (default)',
  `    sync [options]        Sync latest public rates (${PRICING_SOURCE_NAMES.join(' | ')}) via proxy or direct`,
  '      --source <src>      auto (models.dev -> litellm) | models.dev | litellm',
  '      --force             Ignore ETag and force refresh',
  '    set <model> <in> <out> [cacheRead] [cacheWrite]  Save custom USD/1M override',
  '    reset [model|--cache] Remove custom override(s) or clear synced pricing cache',
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
    else if (arg === '--no-shim') flags.withShim = false;
    else if (arg === '--with-shim') flags.withShim = true;
    else if (arg === '--no-title') flags.withTitle = false;
    else if (arg === '--with-title') flags.withTitle = true;
    else if (arg === '--no-shell-hook' || arg === '--no-proxy-hook') flags.withShellHook = false;
    else if (arg === '--with-shell-hook' || arg === '--proxy-hook') flags.withShellHook = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--remove-skill') flags.removeSkill = true;
    else if (arg === '--purge') flags.purge = true;
    else if (arg === '--print-cleanup') flags.printCleanup = true;
    else if (arg === '--plain') flags.plain = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--once') flags.once = true;
    else if (arg === '--capture') flags.capture = true;
    else if (arg === '--show') flags.show = true;
    else if (arg === '--clear') flags.clear = true;
    else if (arg === '--no-cache') flags.noCache = true;
    else if (arg === '--cache') flags.cache = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
    else if (arg === '--sh') flags.shell = 'sh';
    else if (arg === '--fish') flags.shell = 'fish';
    else if (arg === '--pwsh') flags.shell = 'pwsh';
    else if (['--preset', '--theme', '--bar-style', '--color-mode', '--scenario', '--width', '--model', '--interval', '--session', '--source', '--palette', '--shell'].includes(arg)) {
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

  if (command === 'run') {
    const cfg = loadConfig();
    const res = await launchAgyWithProxy(rest, { proxyConfig: cfg.proxy });
    if (res.exitCode) process.exitCode = res.exitCode;
    return;
  }

  if (command === 'proxy') {
    await handleProxyCommand(rest);
    return;
  }

  if (command === 'pricing') {
    await handlePricingCommand(rest);
    return;
  }

  if (command === 'install') {
    const { flags } = parseFlags(rest);
    const withShim = flags.withShim ?? true;
    const hookState = inspectShellHook({ shell: flags.shell ?? null });
    const hookDecision = await resolveInstallShellHookChoice({
      flagValue: flags.withShellHook,
      withShim,
      alreadyInstalled: hookState.installed,
      isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      yes: Boolean(flags.yes),
      promptFn: async () => {
        console.log(formatShellHookPrompt(hookState));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`Enable plain "agy" no-TUN proxy hook in ${hookState.rcPath}? [y/N]: `);
          return /^(?:y|yes)$/i.test(answer.trim());
        } finally {
          rl.close();
        }
      },
    });

    const result = installAgyBar({
      withSkill: flags.withSkill ?? true,
      withShim,
      withTitle: flags.withTitle ?? true,
      withShellHook: hookDecision.enable,
      shell: flags.shell ?? null,
      preset: flags.preset ?? null,
      theme: flags.theme ?? null,
      barStyle: flags.barStyle ?? null,
    });
    console.log(`Installed agy-bar statusline at ${result.scriptPath}`);
    if (result.titleScriptPath) {
      console.log(`Installed native AGY title hook at ${result.titleScriptPath}`);
    } else if (result.titleWarning) {
      console.log(`Note: ${result.titleWarning}`);
    }
    console.log(`Updated AGY settings: ${result.settingsPath}`);
    if (result.shimPath) {
      console.log(`Installed global CLI command: ${result.shimPath}`);
      const shimDir = dirname(result.shimPath);
      const pathDirs = String(process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean);
      const normPath = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
      const onPath = pathDirs.some((p) => normPath(p) === normPath(shimDir));
      if (!onPath) {
        console.log(`Note: add ${shimDir} to your PATH to run "agy-bar" directly.`);
      }
    } else if (result.shimWarning) {
      console.log(`Note: ${result.shimWarning}`);
    }
    if (result.shellHook?.installed) {
      console.log(
        `${result.shellHook.updated ? 'Updated' : 'Installed'} shell hook (${result.shellHook.shell}): ${result.shellHook.rcPath}`,
      );
      if (!result.shellHook.updated) {
        console.log(
          `Run "${result.shellHook.reloadCmd}" (or open a new terminal) — then plain "agy" automatically uses your local proxy without TUN.`,
        );
      }
    } else if (result.shellHook?.warning) {
      console.log(`Note: ${result.shellHook.warning}`);
    } else if (withShim) {
      console.log(
        `Shell rc untouched (${hookState.rcPath}). Launch via local proxy with "agy-bar run", or enable plain "agy" anytime with "agy-bar proxy hook".`,
      );
    }
    if (result.skillPath) {
      console.log(`Installed companion /agy-bar skill: ${result.skillPath}`);
    }
    console.log('Restart agy to activate the new statusline.');
    return;
  }

  if (command === 'uninstall') {
    const { flags } = parseFlags(rest);
    const result = uninstallAgyBar({
      removeSkill: Boolean(flags.removeSkill),
      purge: Boolean(flags.purge),
    });
    const rawShell = flags.shell || detectShell();
    const cleanupShell = rawShell === 'fish' ? 'fish' : rawShell === 'pwsh' ? 'pwsh' : 'sh';
    const cleanupCmd = formatShellCleanup({ shell: cleanupShell, includeUnsetFunc: true });
    const hasProxyEnvInShell = AGY_BAR_CLEANUP_ENV_VARS.some((k) => Boolean(process.env[k]));

    if (flags.printCleanup) {
      process.stderr.write(`${result.message}\n`);
      if (result.shellHookPaths?.length) {
        process.stderr.write(`Removed managed shell hook from: ${result.shellHookPaths.join(', ')}\n`);
      }
      console.log(cleanupCmd);
      return;
    }

    console.log(result.message);
    if (result.shellHookPaths?.length) {
      console.log(`Removed managed shell hook from: ${result.shellHookPaths.join(', ')}`);
    }
    if (result.shellHookRemoved || hasProxyEnvInShell) {
      console.log('To clear proxy env vars & agy() function in this already-open terminal immediately, run:');
      console.log(`  ${cleanupCmd}`);
    }
    return;
  }

  if (command === 'config') {
    const result = applyConfigCommand(rest);
    const safeResult = {
      ...result,
      config: {
        ...result.config,
        proxy: {
          ...result.config.proxy,
          url: redactProxyUrl(result.config.proxy?.url),
        },
      },
    };
    console.log(JSON.stringify(safeResult, null, 2));
    return;
  }

  if (command === 'stats') {
    const { flags, positional } = parseFlags(rest);
    const period = positional[0] || '7d';
    const source = (flags.source || 'all').toLowerCase();
    if (!SOURCE_NAMES.includes(source)) {
      throw new Error(`Invalid --source "${source}". Choose one of: ${SOURCE_NAMES.join(', ')}`);
    }
    const palette = (flags.palette || 'purple').toLowerCase();
    if (!HEATMAP_PALETTE_NAMES.includes(palette)) {
      throw new Error(`Invalid --palette "${palette}". Choose one of: ${HEATMAP_PALETTE_NAMES.join(', ')}`);
    }

    let entries = [];
    let sourceLabel = source;
    if (source === 'ledger') {
      entries = readLedger();
    } else {
      const scan = await scanConversationHistory({
        sourceFilter: source,
        useCache: !flags.noCache,
      });
      if (scan.supported && scan.entries.length > 0) {
        entries = scan.entries;
        sourceLabel = source === 'all' ? 'cli+desktop' : source;
        if (source === 'all') {
          const parentMap = await readConversationParentMap();
          saveUsageSummary(computeUsageSummary(scan.entries, { parentMap }));
        }
      } else {
        entries = readLedger();
        sourceLabel = 'ledger';
      }
    }

    const report = aggregateStats(entries, { period, modelFilter: flags.model || null, sourceLabel });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const cfg = loadConfig();
    if (cfg.pricingAutoSync) {
      maybeTriggerBackgroundPricingSync({ enabled: true });
    }
    const color = !flags.plain && !('NO_COLOR' in process.env) && cfg.theme !== 'mono';
    console.log(formatStatsReport(report, { color, theme: cfg.theme, heatmapPalette: palette }));
    return;
  }

  if (command === 'monitor') {
    const { flags } = parseFlags(rest);
    const intervalMs = flags.interval ? Number(flags.interval) : 1000;
    if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 60000) {
      throw new Error('--interval must be between 250 and 60000 milliseconds.');
    }
    const cfg = loadConfig();
    if (cfg.pricingAutoSync) {
      maybeTriggerBackgroundPricingSync({ enabled: true });
    }
    const color = !flags.plain && !('NO_COLOR' in process.env) && cfg.theme !== 'mono';
    await startMonitor({ intervalMs, once: Boolean(flags.once), color });
    return;
  }

  if (command === 'title') {
    const { flags, positional } = parseFlags(rest);
    const cfg = loadConfig();
    const hostTarget = flags.session ? null : resolveTerminalTarget();
    const hostPid = hostTarget?.hostPid ?? null;
    if (!flags.clear && positional.length === 0) {
      const recent = listSessions();
      const target = flags.session
        ? recent.find((s) => s.sessionId === flags.session)
        : findSessionForHost(recent, hostPid);
      if (!target) {
        console.log('No active agy-bar session found yet.');
        return;
      }
      const nativeTitleActive = isNativeTitleActive(target.sessionId, { hostPid: hostPid ?? process.ppid });
      const resolvedConvTitle =
        target.conversationTitle ||
        (cfg.dbTiming !== false
          ? readConversationSummaryTitle(target.sessionId, {
              prevDbStamp: target.summaryDbStamp ?? null,
              prevTitle: target.conversationTitle ?? null,
              recheckIntervalMs: 0,
            })?.title || null
          : null);
      const computedTitle = buildTabTitle(
        {
          agent_state: target.agentState,
          subagents: target.runningSubagents || 0,
          task_count: target.runningTasks || 0,
          tool_confirmation_pending: Boolean(target.toolConfirmationPending),
          conversation_title: resolvedConvTitle,
          cwd: target.cwd,
        },
        {
          config: cfg,
          git: target.branch ? { branch: target.branch, dirty: target.dirty } : null,
          customTitle: target.customTitle,
        },
      );
      console.log(
        JSON.stringify(
          {
            sessionId: target.sessionId,
            tabTitleEnabled: cfg.tabTitle,
            nativeTitleActive,
            source: cfg.tabTitleSource,
            customTitle: target.customTitle || null,
            conversationTitle: resolvedConvTitle,
            activeTabTitle: (nativeTitleActive ? computedTitle : target.lastTabTitle || computedTitle) || null,
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
      hostPid,
      clear: Boolean(flags.clear),
    });
    const resolvedConvTitle =
      updated.conversationTitle ||
      (cfg.dbTiming !== false
        ? readConversationSummaryTitle(updated.sessionId, {
            prevDbStamp: updated.summaryDbStamp ?? null,
            prevTitle: updated.conversationTitle ?? null,
            recheckIntervalMs: 0,
          })?.title || null
        : null);
    const renderedTitle = buildTabTitle(
      {
        agent_state: updated.agentState,
        subagents: updated.runningSubagents || 0,
        task_count: updated.runningTasks || 0,
        tool_confirmation_pending: Boolean(updated.toolConfirmationPending),
        conversation_title: resolvedConvTitle,
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
      updateSessionTabTitle(updated.sessionId, renderedTitle, { hostPid: writeRes.hostPid, tty: writeRes.tty });
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

async function handleProxyCommand(args) {
  const [sub = 'status', ...rest] = args;

  if (sub === 'run') {
    const cfg = loadConfig();
    const res = await launchAgyWithProxy(rest, { proxyConfig: cfg.proxy });
    if (res.exitCode) process.exitCode = res.exitCode;
    return;
  }

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(
      [
        'Usage: agy-bar proxy <subcommand>',
        '',
        '  status | check            Show configured & effective proxy + live reachability',
        '  auto                      Auto-detect OS or local Clash/Surge/v2ray proxy and save it',
        '  set <url>                 Save a manual proxy URL (e.g. http://127.0.0.1:7897)',
        '  on | off                  Enable or disable proxy injection',
        `  mode <${PROXY_MODES.join('|')}>    Switch proxy resolution mode`,
        `  hook [--shell <${SUPPORTED_SHELLS.join('|')}>] Install agy() shell hook so plain "agy" uses proxy`,
        '  unhook                    Remove the managed agy() shell hook',
        '  bypass <list | reset>     Update comma-separated NO_PROXY list',
        '  env [--sh|--fish|--pwsh]  Output shell export commands for eval',
        '  clear                     Reset proxy settings to default auto mode',
        '  run [agy args...]         Alias for "agy-bar run [agy args...]"',
      ].join('\n'),
    );
    return;
  }

  const cfg = loadConfig();

  if (sub === 'status' || sub === 'check') {
    const { flags } = parseFlags(rest);
    const resolved = await resolveEffectiveProxy(cfg.proxy);
    const hookInfo = inspectShellHook();
    let check = null;
    if (resolved.active && resolved.host && resolved.port) {
      check = await checkLocalPort(resolved.host, resolved.port, 500);
    }

    const summary = {
      mode: cfg.proxy.mode,
      savedUrl: redactProxyUrl(cfg.proxy.url),
      active: resolved.active,
      effectiveUrl: redactProxyUrl(resolved.url),
      source: resolved.source || null,
      reachable: check ? check.reachable : null,
      latencyMs: check ? check.latencyMs : null,
      error: check && !check.reachable ? check.error : null,
      bypass: resolved.bypass,
      shellHook: hookInfo,
      warning: resolved.warning || null,
      reason: resolved.active ? null : resolved.reason,
    };

    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const lines = [
      `agy-bar no-TUN proxy`,
      `  Mode:       ${summary.mode}`,
      `  Saved URL:  ${summary.savedUrl || '(none — auto-detect)'}`,
      `  Effective:  ${summary.effectiveUrl ? `${summary.effectiveUrl} (${summary.source})` : `(none — ${summary.reason})`}`,
    ];
    if (check) {
      lines.push(
        `  Status:     ${check.reachable ? `✓ reachable (${check.latencyMs}ms)` : `✗ unreachable (${check.error || 'refused'})`}`,
      );
    }
    lines.push(`  NO_PROXY:   ${summary.bypass.join(',')}`);
    lines.push(
      `  Shell hook: ${hookInfo.installed ? `✓ active in ${hookInfo.rcPath} (plain "agy" auto-proxies)` : `not installed (run "agy-bar proxy hook" to enable plain "agy")`}`,
    );
    if (summary.warning) {
      lines.push(`  Note:       ${summary.warning}`);
    }
    lines.push('');
    lines.push(
      hookInfo.installed
        ? '  Launch agy without TUN:  agy [args...]  (bypass once: command agy / AGY_BAR_NO_PROXY=1 agy)'
        : '  Launch agy without TUN:  agy-bar run [agy args...]  (or enable plain "agy": agy-bar proxy hook)',
    );
    console.log(lines.join('\n'));
    return;
  }

  if (sub === 'hook') {
    const { flags } = parseFlags(rest);
    const res = installShellHook({ shell: flags.shell || null });
    if (res.skipped) {
      console.log(res.warning);
      process.exitCode = 1;
      return;
    }
    console.log(`${res.updated ? 'Updated' : 'Installed'} agy-bar shell hook (${res.shell}) in ${res.rcPath}`);
    console.log(`Run "${res.reloadCmd}" (or open a new terminal) — then just type "agy" to launch through your local proxy without TUN.`);
    return;
  }

  if (sub === 'unhook') {
    const { flags } = parseFlags(rest);
    const res = uninstallShellHook({ shell: flags.shell || null });
    if (!res.removed) {
      console.log('No managed agy-bar shell hook was found.');
      return;
    }
    console.log(`Removed agy-bar shell hook from: ${res.rcPaths.join(', ')}`);
    console.log('Open a new terminal (or run "unset -f agy") to restore plain agy immediately.');
    return;
  }

  if (sub === 'set') {
    const rawUrl = rest[0];
    if (!rawUrl || rest.length > 1) {
      throw new Error('Usage: agy-bar proxy set <url>  (e.g. agy-bar proxy set http://127.0.0.1:7897)');
    }
    const parsed = validateProxyUrl(rawUrl);
    saveConfig({
      ...cfg,
      proxy: { ...cfg.proxy, mode: 'manual', url: parsed.url },
    });
    const check = await checkLocalPort(parsed.host, parsed.port, 500);
    console.log(`Saved proxy: ${redactProxyUrl(parsed.url)} (mode=manual)`);
    console.log(
      `Reachability: ${check.reachable ? `✓ listening (${check.latencyMs}ms)` : `✗ not listening right now (${check.error || 'refused'})`}`,
    );
    if (parsed.warning) console.log(`Note: ${parsed.warning}`);
    console.log('Launch agy with: agy-bar run');
    return;
  }

  if (sub === 'auto') {
    const detected = (await detectLocalProxy({ includeEnv: false })) || readEnvProxy();
    if (!detected) {
      const portList = COMMON_LOCAL_PROXY_PORTS.map((p) => p.port).join(', ');
      throw new Error(
        `No active local proxy detected (checked OS system proxy and 127.0.0.1 ports: ${portList}). Start Clash/Surge/v2ray or set one manually with "agy-bar proxy set http://127.0.0.1:<port>".`,
      );
    }
    const parsed = validateProxyUrl(detected.url);
    const check = await checkLocalPort(parsed.host, parsed.port, 500);
    const mergedBypass = normalizeBypassList([...cfg.proxy.bypass, ...(detected.bypass || [])]);
    saveConfig({
      ...cfg,
      proxy: { mode: 'manual', url: parsed.url, bypass: mergedBypass },
    });
    console.log(`Detected & saved proxy: ${redactProxyUrl(parsed.url)} (${detected.source})`);
    console.log(
      `Reachability: ${check.reachable ? `✓ listening (${check.latencyMs}ms)` : `✗ unreachable (${check.error || 'refused'})`}`,
    );
    if (parsed.warning) console.log(`Note: ${parsed.warning}`);
    console.log('Launch agy with: agy-bar run');
    return;
  }

  if (sub === 'on') {
    const nextMode = cfg.proxy.url ? 'manual' : 'auto';
    saveConfig({ ...cfg, proxy: { ...cfg.proxy, mode: nextMode } });
    console.log(
      nextMode === 'manual'
        ? `Enabled proxy: ${redactProxyUrl(cfg.proxy.url)} (mode=manual)`
        : 'Enabled proxy in auto-detect mode (mode=auto).',
    );
    return;
  }

  if (sub === 'off') {
    saveConfig({ ...cfg, proxy: { ...cfg.proxy, mode: 'off' } });
    console.log('Disabled agy-bar proxy injection (mode=off). Saved URL was preserved.');
    return;
  }

  if (sub === 'mode') {
    const mode = String(rest[0] || '').toLowerCase();
    if (!PROXY_MODES.includes(mode)) {
      throw new Error(`Invalid proxy mode "${rest[0] || ''}". Choose one of: ${PROXY_MODES.join(', ')}`);
    }
    if (mode === 'manual' && !cfg.proxy.url) {
      throw new Error('Cannot switch to manual mode without a saved URL. Run "agy-bar proxy set <url>" or "agy-bar proxy auto" first.');
    }
    saveConfig({ ...cfg, proxy: { ...cfg.proxy, mode } });
    console.log(`Switched proxy mode to "${mode}".`);
    return;
  }

  if (sub === 'bypass') {
    if (rest.length === 0) {
      console.log(cfg.proxy.bypass.join(','));
      return;
    }
    const nextBypass =
      rest[0].toLowerCase() === 'reset'
        ? [...DEFAULT_PROXY_BYPASS]
        : normalizeBypassList(['127.0.0.1', 'localhost', '::1', ...rest.join(',').split(',')]);
    saveConfig({ ...cfg, proxy: { ...cfg.proxy, bypass: nextBypass } });
    console.log(`Updated NO_PROXY: ${nextBypass.join(',')}`);
    return;
  }

  if (sub === 'env') {
    const { flags } = parseFlags(rest);
    const shell = flags.shell || (process.platform === 'win32' ? 'pwsh' : 'sh');
    const resolved = await resolveEffectiveProxy(cfg.proxy);
    console.log(formatShellExports(resolved, { shell }));
    return;
  }

  if (sub === 'clear' || sub === 'reset') {
    saveConfig({ ...cfg, proxy: { ...DEFAULT_PROXY_CONFIG, bypass: [...DEFAULT_PROXY_BYPASS] } });
    console.log('Reset proxy settings to default auto-detect mode.');
    return;
  }

  throw new Error(`Unknown proxy subcommand "${sub}". Run "agy-bar proxy --help" for usage.`);
}

async function handlePricingCommand(args) {
  const [sub = 'show', ...rest] = args;
  const cfg = loadConfig();

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(
      [
        'Usage: agy-bar pricing <subcommand>',
        '',
        '  show [--json]                                   Show cache status & active per-1M rates (default)',
        `  sync [--source ${PRICING_SOURCE_NAMES.join('|')}] [--force]  Sync latest public pricing catalog`,
        '  set <model> <in> <out> [cacheRead] [cacheWrite] Save custom USD per 1M token override',
        '  reset [model | --cache]                         Clear custom overrides or synced cache',
      ].join('\n'),
    );
    return;
  }

  if (sub === 'show' || sub === 'status') {
    const { flags } = parseFlags(rest);
    const cache = readPricingCache();
    const ageHours = cache?.fetchedAt ? Math.round(((Date.now() - cache.fetchedAt) / 3_600_000) * 10) / 10 : null;
    const sampleModels = [
      'Gemini 4 Neon',
      'Gemini 4 Carbon',
      'Gemini 4 Argon',
      'Gemini 4 Hydrogen',
      'Gemini 3.8 Flash',
      'Gemini 2.5 Pro',
      'Gemini 2.5 Flash',
      'Claude Opus 4.6',
      'Claude Sonnet 4.6',
      'Claude Haiku 4.5',
    ];
    for (const customKey of Object.keys(cfg.customPricing || {})) {
      if (!sampleModels.some((m) => normalizeModelKey(m) === normalizeModelKey(customKey))) {
        sampleModels.push(customKey);
      }
    }
    const rows = sampleModels.map((model) => {
      const rate = lookupRates(model, { customPricing: cfg.customPricing, pricingCache: cache });
      return {
        model,
        input: rate?.input ?? null,
        output: rate?.output ?? null,
        cacheRead: rate?.cacheRead ?? null,
        cacheWrite: rate?.cacheWrite ?? null,
        source: rate?.source ?? 'unpriced',
      };
    });

    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            autoSync: cfg.pricingAutoSync,
            cache: cache
              ? {
                  source: cache.source,
                  fetchedAt: new Date(cache.fetchedAt).toISOString(),
                  ageHours,
                  cachedModels: Object.keys(cache.rates || {}).length,
                  path: pricingCachePath(),
                }
              : null,
            customOverrides: cfg.customPricing,
            effectiveRates: rows,
          },
          null,
          2,
        ),
      );
      return;
    }

    const lines = [
      'agy-bar model pricing (USD per 1M tokens)',
      `  Auto-sync:  ${cfg.pricingAutoSync ? 'on (24h background SWR; disable: agy-bar config set pricingAutoSync off)' : 'off (manual: agy-bar pricing sync)'}`,
      `  Cache:      ${cache ? `${cache.source} · ${Object.keys(cache.rates || {}).length} models · updated ${ageHours}h ago` : 'not synced yet (using built-in calibrated rates)'}`,
      '',
      `  ${'Model'.padEnd(20)} ${'Input'.padStart(7)} ${'Output'.padStart(7)} ${'CacheRd'.padStart(8)}  Source`,
      `  ${'─'.repeat(58)}`,
    ];
    for (const r of rows) {
      const fmt = (n) => (typeof n === 'number' ? `$${n < 1 ? n.toFixed(3).replace(/0+$/, '') : n.toFixed(2)}` : '--');
      lines.push(
        `  ${r.model.padEnd(20)} ${fmt(r.input).padStart(7)} ${fmt(r.output).padStart(7)} ${fmt(r.cacheRead).padStart(8)}  ${r.source}`,
      );
    }
    lines.push('');
    lines.push('  Refresh now: agy-bar pricing sync   |   Override: agy-bar pricing set <model> <in> <out> [cacheRead]');
    console.log(lines.join('\n'));
    return;
  }

  if (sub === 'sync') {
    const { flags } = parseFlags(rest);
    const source = (flags.source || 'auto').toLowerCase();
    if (!PRICING_SOURCE_NAMES.includes(source)) {
      throw new Error(`Invalid --source "${source}". Choose one of: ${PRICING_SOURCE_NAMES.join(', ')}`);
    }
    const res = await syncPricingCache({
      proxyConfig: cfg.proxy,
      source,
      force: Boolean(flags.force),
    });
    if (!res.ok) {
      if (!flags.quiet) {
        throw new Error(`Pricing sync failed (${res.error}). Keeping existing local rates.`);
      }
      process.exitCode = 1;
      return;
    }
    if (!flags.quiet) {
      console.log(
        res.notModified
          ? `Pricing cache is already up to date (${res.source}, ${res.count} models, HTTP 304).`
          : `Synced ${res.count} model rates from ${res.source} -> ${res.cachePath}`,
      );
    }
    return;
  }

  if (sub === 'set') {
    const [rawModel, rawIn, rawOut, rawCr, rawCw] = rest;
    if (!rawModel || !rawIn || !rawOut) {
      throw new Error('Usage: agy-bar pricing set <model> <input> <output> [cacheRead] [cacheWrite]  (USD per 1M tokens)');
    }
    const key = normalizeModelKey(rawModel);
    const input = Number(rawIn);
    const output = Number(rawOut);
    const cacheRead = rawCr !== undefined ? Number(rawCr) : Math.round(input * 1000) / 10_000;
    const cacheWrite = rawCw !== undefined ? Number(rawCw) : input;
    if (!key || !Number.isFinite(input) || input <= 0 || input > 500 || !Number.isFinite(output) || output <= 0 || output > 1000) {
      throw new Error('Input (0..500) and output (0..1000) must be valid positive numbers in USD per 1M tokens.');
    }
    if (!Number.isFinite(cacheRead) || cacheRead < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0) {
      throw new Error('cacheRead and cacheWrite must be non-negative numbers.');
    }
    const nextCustom = {
      ...(cfg.customPricing || {}),
      [key]: { input, output, cacheRead, cacheWrite },
    };
    saveConfig({ ...cfg, customPricing: nextCustom });
    clearPricingMemo();
    try {
      rmSync(usageSummaryPath(), { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    console.log(`Saved custom pricing for "${key}": in=$${input}/1M out=$${output}/1M cacheRead=$${cacheRead}/1M`);
    return;
  }

  if (sub === 'reset') {
    const { flags, positional } = parseFlags(rest);
    const invalidateSummary = () => {
      try {
        rmSync(usageSummaryPath(), { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    };
    if (flags.cache) {
      rmSync(pricingCachePath(), { force: true });
      clearPricingMemo();
      invalidateSummary();
      console.log('Cleared synced pricing cache (reverted to built-in calibrated rates).');
      return;
    }
    const target = positional[0] ? normalizeModelKey(positional[0]) : null;
    if (target) {
      const nextCustom = { ...(cfg.customPricing || {}) };
      delete nextCustom[target];
      saveConfig({ ...cfg, customPricing: nextCustom });
      clearPricingMemo();
      invalidateSummary();
      console.log(`Removed custom pricing override for "${target}".`);
      return;
    }
    saveConfig({ ...cfg, customPricing: {} });
    clearPricingMemo();
    invalidateSummary();
    console.log(`Cleared all custom pricing overrides (${BUILTIN_RATES.length} built-in fallback rates active).`);
    return;
  }

  throw new Error(`Unknown pricing subcommand "${sub}". Run "agy-bar pricing --help" for usage.`);
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

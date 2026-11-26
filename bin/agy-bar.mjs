#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
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
import { computeUsageSummary, saveUsageSummary, scanConversationHistory } from '../src/history-scan.mjs';
import { installAgyBar, runDoctor, uninstallAgyBar } from '../src/installer.mjs';
import { startMonitor } from '../src/monitor.mjs';
import { buildPreviewOutput } from '../src/preview.mjs';
import {
  checkLocalPort,
  COMMON_LOCAL_PROXY_PORTS,
  DEFAULT_PROXY_BYPASS,
  DEFAULT_PROXY_CONFIG,
  detectLocalProxy,
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
import { aggregateStats, formatStatsReport, HEATMAP_PALETTE_NAMES, PERIOD_NAMES, readLedger, SOURCE_NAMES } from '../src/stats.mjs';
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
  '  install [options]       Install statusline + global ~/.local/bin/agy-bar command',
  '    --no-skill            Skip installing the companion /agy-bar skill',
  '    --no-shim             Skip installing the ~/.local/bin/agy-bar shortcut command',
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
  '  proxy [subcommand]      Configure, auto-detect, or test no-TUN proxy settings',
  '    status | check        Show effective proxy & live localhost TCP reachability (default)',
  '    auto                  Auto-detect OS / local Clash/Surge/v2ray proxy and save it',
  '    set <url>             Save a manual proxy URL (e.g. http://127.0.0.1:7897)',
  '    on | off              Enable or disable proxy injection without losing saved URL',
  `    mode <mode>           Switch proxy mode (${PROXY_MODES.join(' | ')})`,
  '    bypass <list|reset>   Set comma-separated NO_PROXY list (always keeps loopback)',
  '    env [--sh|--fish|--pwsh] Print shell export commands (e.g. eval "$(agy-bar proxy env)")',
  '    clear                 Reset proxy settings back to default auto-detect mode',
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
  '  stats [period] [opts]   Full-history token dashboard, terminal heatmap & API cost estimate',
  `    period                ${PERIOD_NAMES.join(' | ')} (default: 7d)`,
  `    --source <src>        ${SOURCE_NAMES.join(' | ')} (default: all — scans CLI + Desktop DBs)`,
  `    --palette <name>      Heatmap ramp: ${HEATMAP_PALETTE_NAMES.join(' | ')} (default: purple)`,
  '    --model <filter>      Filter by model substring (e.g. claude, carbon, neon)',
  '    --no-cache            Force full re-scan of conversation DBs',
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
    else if (arg === '--no-shim') flags.withShim = false;
    else if (arg === '--with-shim') flags.withShim = true;
    else if (arg === '--remove-skill') flags.removeSkill = true;
    else if (arg === '--purge') flags.purge = true;
    else if (arg === '--plain') flags.plain = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--once') flags.once = true;
    else if (arg === '--capture') flags.capture = true;
    else if (arg === '--show') flags.show = true;
    else if (arg === '--clear') flags.clear = true;
    else if (arg === '--no-cache') flags.noCache = true;
    else if (arg === '--sh') flags.shell = 'sh';
    else if (arg === '--fish') flags.shell = 'fish';
    else if (arg === '--pwsh') flags.shell = 'pwsh';
    else if (['--preset', '--theme', '--bar-style', '--color-mode', '--scenario', '--width', '--model', '--interval', '--session', '--source', '--palette'].includes(arg)) {
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

  if (command === 'install') {
    const { flags } = parseFlags(rest);
    const result = installAgyBar({
      withSkill: flags.withSkill ?? true,
      withShim: flags.withShim ?? true,
      preset: flags.preset ?? null,
      theme: flags.theme ?? null,
      barStyle: flags.barStyle ?? null,
    });
    console.log(`Installed agy-bar statusline at ${result.scriptPath}`);
    console.log(`Updated AGY settings: ${result.settingsPath}`);
    if (result.shimPath) {
      console.log(`Installed global CLI command: ${result.shimPath}`);
      const shimDir = dirname(result.shimPath);
      const pathDirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
      const onPath = pathDirs.some((p) => resolve(p) === resolve(shimDir));
      if (!onPath) {
        console.log(`Note: add ${shimDir} to your PATH to run "agy-bar" directly.`);
      }
    } else if (result.shimWarning) {
      console.log(`Note: ${result.shimWarning}`);
    }
    if (result.skillPath) {
      console.log(`Installed companion /agy-bar skill: ${result.skillPath}`);
    }
    console.log('Restart agy to activate the new statusline (or run "agy-bar run" to launch agy via your local proxy without TUN).');
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
          saveUsageSummary(computeUsageSummary(scan.entries));
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
      updateSessionTabTitle(updated.sessionId, renderedTitle, { hostPid: writeRes.hostPid });
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
    if (summary.warning) {
      lines.push(`  Note:       ${summary.warning}`);
    }
    lines.push('');
    lines.push('  Launch agy without TUN:  agy-bar run [agy args...]');
    lines.push('  Optional shell alias:    alias agy=\'agy-bar run\'');
    console.log(lines.join('\n'));
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

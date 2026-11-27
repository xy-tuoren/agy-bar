#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, fg } from '../src/ansi.mjs';
import { BAR_STYLE_NAMES, normalizeConfig } from '../src/config.mjs';
import { renderMonitorFrame } from '../src/monitor.mjs';
import { SAMPLE_PAYLOADS, SAMPLE_TELEMETRY } from '../src/preview.mjs';
import { renderBar, renderStatusline } from '../src/render.mjs';
import { resolvePalette } from '../src/themes.mjs';

const ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url));
const TRUECOLOR_ENV = { COLORTERM: 'truecolor' };
const MONO_FONT = "'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace";

function escapeXml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function ansiToTspans(line, defaultFill) {
  const parts = [];
  const tokenRegex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentFill = defaultFill;
  let isBold = false;

  const pushChunk = (text) => {
    if (!text) return;
    const weight = isBold ? ' font-weight="700"' : '';
    parts.push(`<tspan fill="${currentFill}"${weight}>${escapeXml(text)}</tspan>`);
  };

  for (const match of line.matchAll(tokenRegex)) {
    pushChunk(line.slice(lastIndex, match.index));
    const codes = match[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        currentFill = defaultFill;
        isBold = false;
      } else if (c === 1) {
        isBold = true;
      } else if (c === 22) {
        isBold = false;
      } else if (c === 38 && codes[i + 1] === 2 && codes.length >= i + 5) {
        currentFill = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
    lastIndex = match.index + match[0].length;
  }
  pushChunk(line.slice(lastIndex));
  return parts.join('');
}

function buildTerminalCard({
  title,
  subtitle,
  lines,
  yStart = 18,
  widthPx = 980,
  lineHeight = 19,
  fontSize = 12,
  bg = '#0f172a',
  border = '#1e293b',
  titleFill = '#e2e8f0',
  subFill = '#64748b',
  defaultTextFill = '#e8ecf2',
}) {
  const headerH = 44;
  const padX = 24;
  const padBottom = 20;
  const cardH = Math.ceil(headerH + 14 + lines.length * lineHeight + padBottom);

  const elems = [
    `<rect x="20" y="${yStart}" width="${widthPx - 40}" height="${cardH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`,
    `<circle cx="42" cy="${yStart + 22}" r="5.5" fill="#ff5f57"/>`,
    `<circle cx="60" cy="${yStart + 22}" r="5.5" fill="#febc2e"/>`,
    `<circle cx="78" cy="${yStart + 22}" r="5.5" fill="#28c840"/>`,
    `<text x="98" y="${yStart + 26}" font-family="${MONO_FONT}" font-size="12" font-weight="600" fill="${titleFill}">${escapeXml(title)}</text>`,
    `<text x="${widthPx - 44}" y="${yStart + 26}" text-anchor="end" font-family="${MONO_FONT}" font-size="11" fill="${subFill}">${escapeXml(subtitle)}</text>`,
    `<line x1="20" y1="${yStart + 40}" x2="${widthPx - 20}" y2="${yStart + 40}" stroke="${border}" stroke-width="1"/>`,
  ];

  let y = yStart + headerH + 20;
  for (const line of lines) {
    elems.push(
      `<text x="${20 + padX}" y="${y}" xml:space="preserve" font-family="${MONO_FONT}" font-size="${fontSize}">${ansiToTspans(line, defaultTextFill)}</text>`,
    );
    y += lineHeight;
  }

  return { svg: elems.join('\n  '), height: cardH };
}

function wrapSvg(body, widthPx, totalHeight, ariaLabel) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${totalHeight}" viewBox="0 0 ${widthPx} ${totalHeight}" role="img" aria-label="${escapeXml(ariaLabel)}">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#020617"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </linearGradient>
  </defs>
  <rect width="${widthPx}" height="${totalHeight}" rx="16" fill="url(#bg-grad)"/>
  ${body}
</svg>
`;
}

function writeAsset(filename, content) {
  const outPath = `${ASSETS_DIR}/${filename}`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, 'utf8');
  console.log(`Generated ${outPath}`);
}

// 1. Multi-CLI Monitor Preview (assets/monitor-preview.svg)
function generateMonitorSvg() {
  const now = new Date('2026-11-26T16:00:00Z').getTime();
  const frame = renderMonitorFrame(
    [
      {
        sessionId: 'sess-agy-bar',
        ageMs: 2_000,
        isBusy: true,
        agentState: 'working',
        workspaceName: 'agy-bar',
        branch: 'main',
        dirty: true,
        model: 'Gemini 4 Neon',
        usedPct: 42.6,
        cacheHitPct: 88,
        lastActivityAt: now - 78_000,
        lastTtftMs: 1850,
        lastSpeedTokPerSec: 158,
        sessionCostUsd: 0.84,
        quota: {
          'gemini-5h': { remaining: 0.85, reset_in_seconds: 9000 },
          'gemini-weekly': { remaining: 0.64, reset_in_seconds: 259200 },
          '3p-5h': { remaining: 0.74, reset_in_seconds: 7200 },
        },
      },
      {
        sessionId: 'sess-web-app',
        ageMs: 12_000,
        isBusy: true,
        activityKind: 'subagents',
        runningSubagents: 3,
        agentState: 'idle',
        workspaceName: 'web-app',
        branch: 'feat/auth',
        dirty: false,
        model: 'Claude Sonnet 4.6',
        usedPct: 74.2,
        cacheHitPct: 72,
        lastActivityAt: now - 222_000,
        lastTtftMs: 2400,
        lastSpeedTokPerSec: 112,
        sessionCostUsd: 1.42,
        quota: null,
      },
      {
        sessionId: 'sess-api-svc',
        ageMs: 45_000,
        isBusy: true,
        activityKind: 'confirm',
        agentState: 'reviewing',
        workspaceName: 'api-svc',
        branch: 'fix/sql',
        dirty: true,
        model: 'Gemini 4 Carbon',
        usedPct: 91.4,
        cacheHitPct: 54,
        lastActivityAt: now - 360_000,
        lastTtftMs: 8200,
        lastSpeedTokPerSec: 64,
        sessionCostUsd: 2.15,
        quota: null,
      },
      {
        sessionId: 'sess-docs',
        ageMs: 180_000,
        isBusy: false,
        activityKind: 'idle',
        agentState: 'idle',
        workspaceName: 'docs-site',
        branch: 'main',
        dirty: false,
        model: 'Gemini 4 Neon',
        usedPct: 18.5,
        cacheHitPct: 94,
        lastActivityAt: now - 180_000,
        lastTtftMs: 1400,
        lastSpeedTokPerSec: 172,
        sessionCostUsd: 0.28,
        quota: null,
      },
    ],
    {
      now,
      color: true,
      env: TRUECOLOR_ENV,
      columns: 104,
      config: normalizeConfig({ theme: 'slate-dark', colorMode: 'health', barStyle: 'segments' }),
    },
  );

  const widthPx = 1040;
  const card = buildTerminalCard({
    title: 'agy-bar monitor · Live Multi-CLI Session HUD',
    subtitle: 'tracks all concurrent agy terminals side by side',
    lines: frame.split('\n'),
    widthPx,
    lineHeight: 20,
    fontSize: 12,
  });
  writeAsset('monitor-preview.svg', wrapSvg(card.svg, widthPx, card.height + 36, 'agy-bar multi-CLI monitor preview'));
}

// 2. Themes & 8 Gauge Styles Showcase (assets/styles-preview.svg)
function generateStylesSvg() {
  const { palette: p } = resolvePalette('slate-dark', { env: TRUECOLOR_ENV });
  const styleLines = [
    bold(fg('8 Built-in Gauge Styles', p.accent, true), true) + fg('  ·  agy-bar config bar-style <name>', p.muted, true),
    '',
  ];

  for (const style of BAR_STYLE_NAMES) {
    const tag = style === 'segments' ? `${style} (default)` : style;
    const gGood = renderBar(0.45, { width: 8, style, fillColor: p.good, trackColor: p.track, color: true });
    const gWarn = renderBar(0.76, { width: 8, style, fillColor: p.warn, trackColor: p.track, color: true });
    const gCrit = renderBar(0.92, { width: 8, style, fillColor: p.danger, trackColor: p.track, color: true });
    styleLines.push(
      `${fg(tag.padEnd(20), style === 'segments' ? p.text : p.muted, true)}  ` +
        `${fg('45%', p.muted, true)} ${gGood}    ` +
        `${fg('76%', p.muted, true)} ${gWarn}    ` +
        `${fg('92%', p.muted, true)} ${gCrit}`,
    );
  }

  styleLines.push('');
  styleLines.push(
    bold(fg('Themes & Color Modes', p.accent, true), true) +
      fg('  ·  agy-bar config theme <name>  |  colorMode health|distinct', p.muted, true),
  );
  styleLines.push('');

  const themeSamples = [
    ['slate-dark · health', { preset: 'compact', theme: 'slate-dark', colorMode: 'health', barStyle: 'segments' }],
    ['ocean · distinct', { preset: 'compact', theme: 'ocean', colorMode: 'distinct', barStyle: 'pills' }],
    ['nord · health', { preset: 'compact', theme: 'nord', colorMode: 'health', barStyle: 'squares' }],
  ];
  for (const [label, cfgInput] of themeSamples) {
    const row = renderStatusline(
      { ...SAMPLE_PAYLOADS.normal, terminal_width: 96 },
      {
        config: normalizeConfig(cfgInput),
        color: true,
        git: { branch: 'main', dirty: false },
        telemetry: SAMPLE_TELEMETRY.normal,
        env: TRUECOLOR_ENV,
        home: '/Users/dev',
      },
    );
    styleLines.push(`${fg(label.padEnd(21), p.muted, true)} ${row}`);
  }

  const widthPx = 1040;
  const card = buildTerminalCard({
    title: 'agy-bar · Gauge Styles, Themes & Color Modes',
    subtitle: 'instant live reload · zero restart needed',
    lines: styleLines,
    widthPx,
    lineHeight: 21,
    fontSize: 12,
  });
  writeAsset('styles-preview.svg', wrapSvg(card.svg, widthPx, card.height + 36, 'agy-bar gauge styles and themes preview'));
}

// 3. No-TUN Proxy & Live Pricing Cache Preview (assets/proxy-pricing-preview.svg)
function generateProxyPricingSvg() {
  const { palette: p } = resolvePalette('slate-dark', { env: TRUECOLOR_ENV });

  const proxyLines = [
    `${fg('$', p.muted, true)} ${bold(fg('agy-bar proxy status', p.text, true), true)}`,
    `${fg('agy-bar no-TUN proxy', p.accent, true)}`,
    `  ${fg('Mode:       ', p.muted, true)}${fg('auto', p.text, true)}`,
    `  ${fg('Effective:  ', p.muted, true)}${fg('http://127.0.0.1:7897', p.text, true)} ${fg('(localhost:7897 · Clash Verge / Mihomo)', p.muted, true)}`,
    `  ${fg('Status:     ', p.muted, true)}${fg('✓ reachable (1ms)', p.good, true)}`,
    `  ${fg('NO_PROXY:   ', p.muted, true)}${fg('127.0.0.1,localhost,::1,.local', p.muted, true)}`,
    `  ${fg('Shell hook: ', p.muted, true)}${fg('✓ active in ~/.zshrc (plain "agy" auto-proxies)', p.good, true)}`,
    '',
    `${fg('$', p.muted, true)} ${bold(fg('agy -c', p.text, true), true)}   ${fg('# No TUN mode needed — just type plain agy!', p.muted, true)}`,
    `${fg('agy-bar: proxy http://127.0.0.1:7897 (no-TUN)', p.muted, true)}`,
    `${fg('~/code/agy-bar', p.text, true)} ${fg('(', p.muted, true)}${fg('main', p.branch, true)}${fg('*', p.warn, true)} ${fg('+142', p.good, true)} ${fg('-38', p.danger, true)}${fg(')', p.muted, true)} ${fg('·', p.sep, true)} ${fg('PX', p.muted, true)} ${fg('7897', p.good, true)}`,
  ];

  const pricingLines = [
    `${fg('$', p.muted, true)} ${bold(fg('agy-bar pricing show', p.text, true), true)}`,
    `${fg('agy-bar model pricing (USD per 1M tokens)', p.accent, true)}`,
    `  ${fg('Auto-sync: ', p.muted, true)} ${fg('on (24h background SWR · zero auth · disable: pricingAutoSync off)', p.text, true)}`,
    `  ${fg('Cache:     ', p.muted, true)} ${fg('models.dev · 33 models · updated 0.2h ago (ETag 304)', p.good, true)}`,
    '',
    `  ${fg('Model'.padEnd(20), p.muted, true)} ${fg('Input'.padStart(7), p.muted, true)} ${fg('Output'.padStart(7), p.muted, true)} ${fg('CacheRd'.padStart(8), p.muted, true)}  ${fg('Source', p.muted, true)}`,
    `  ${fg('─'.repeat(58), p.sep, true)}`,
    `  ${fg('Gemini 4 Neon'.padEnd(20), p.text, true)} ${fg('$3.00'.padStart(7), p.text, true)} ${fg('$15.00'.padStart(7), p.text, true)} ${fg('$0.15'.padStart(8), p.good, true)}  ${fg('builtin', p.muted, true)}`,
    `  ${fg('Gemini 4 Carbon'.padEnd(20), p.text, true)} ${fg('$2.00'.padStart(7), p.text, true)} ${fg('$10.00'.padStart(7), p.text, true)} ${fg('$0.10'.padStart(8), p.good, true)}  ${fg('builtin', p.muted, true)}`,
    `  ${fg('Gemini 4 Hydrogen'.padEnd(20), p.text, true)} ${fg('$1.50'.padStart(7), p.text, true)} ${fg('$7.50'.padStart(7), p.text, true)} ${fg('$0.075'.padStart(8), p.good, true)}  ${fg('builtin', p.muted, true)}`,
    `  ${fg('Claude Opus 4.6'.padEnd(20), p.text, true)} ${fg('$5.00'.padStart(7), p.text, true)} ${fg('$25.00'.padStart(7), p.text, true)} ${fg('$0.50'.padStart(8), p.good, true)}  ${fg('cache:models.dev', p.accent, true)}`,
    `  ${fg('Claude Sonnet 4.6'.padEnd(20), p.text, true)} ${fg('$3.00'.padStart(7), p.text, true)} ${fg('$15.00'.padStart(7), p.text, true)} ${fg('$0.30'.padStart(8), p.good, true)}  ${fg('cache:models.dev', p.accent, true)}`,
  ];

  const widthPx = 980;
  const topCard = buildTerminalCard({
    title: 'agy-bar proxy · No-TUN Local Proxy Launcher',
    subtitle: 'Clash / Surge / v2ray auto-detect · zero binary patching',
    lines: proxyLines,
    yStart: 18,
    widthPx,
    lineHeight: 19.5,
    fontSize: 12,
  });
  const botCard = buildTerminalCard({
    title: 'agy-bar pricing · 3-Tier Dynamic API Pricing Cache',
    subtitle: 'custom > 24h cache > builtin · <0.1ms lookup',
    lines: pricingLines,
    yStart: 18 + topCard.height + 16,
    widthPx,
    lineHeight: 19.5,
    fontSize: 12,
  });

  const totalH = 18 + topCard.height + 16 + botCard.height + 18;
  writeAsset(
    'proxy-pricing-preview.svg',
    wrapSvg(`${topCard.svg}\n  ${botCard.svg}`, widthPx, totalH, 'agy-bar no-TUN proxy and dynamic pricing cache preview'),
  );
}

generateMonitorSvg();
generateStylesSvg();
generateProxyPricingSvg();

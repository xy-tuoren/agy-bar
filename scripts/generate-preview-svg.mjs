#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.mjs';
import { SAMPLE_PAYLOADS, SAMPLE_TELEMETRY } from '../src/preview.mjs';
import { renderStatusline } from '../src/render.mjs';

const OUTPUT_PATH = fileURLToPath(new URL('../assets/preview.svg', import.meta.url));

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

function buildSection({ title, subtitle, bg, border, titleFill, subFill, defaultTextFill, rows, yStart, widthPx }) {
  const lineHeight = 20;
  const headerH = 44;
  const padX = 24;
  const padBottom = 18;
  const totalLines = rows.reduce((acc, r) => acc + r.lines.length + (r.label ? 1 : 0), 0);
  const gapCount = Math.max(0, rows.length - 1);
  const cardH = headerH + totalLines * lineHeight + gapCount * 16 + padBottom;

  const elems = [];
  elems.push(
    `<rect x="20" y="${yStart}" width="${widthPx - 40}" height="${cardH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`,
  );
  // macOS traffic lights
  elems.push(`<circle cx="42" cy="${yStart + 22}" r="5.5" fill="#ff5f57"/>`);
  elems.push(`<circle cx="60" cy="${yStart + 22}" r="5.5" fill="#febc2e"/>`);
  elems.push(`<circle cx="78" cy="${yStart + 22}" r="5.5" fill="#28c840"/>`);
  elems.push(
    `<text x="98" y="${yStart + 26}" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="12" font-weight="600" fill="${titleFill}">${escapeXml(title)}</text>`,
  );
  elems.push(
    `<text x="${widthPx - 44}" y="${yStart + 26}" text-anchor="end" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="11" fill="${subFill}">${escapeXml(subtitle)}</text>`,
  );
  elems.push(`<line x1="20" y1="${yStart + 40}" x2="${widthPx - 20}" y2="${yStart + 40}" stroke="${border}" stroke-width="1"/>`);

  let y = yStart + headerH + 14;
  rows.forEach((row, idx) => {
    if (row.label) {
      elems.push(
        `<text x="${20 + padX}" y="${y}" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="10.5" fill="${subFill}">${escapeXml(row.label)}</text>`,
      );
      y += lineHeight - 2;
    }
    for (const line of row.lines) {
      elems.push(
        `<text x="${20 + padX}" y="${y}" xml:space="preserve" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="12.5">${ansiToTspans(line, defaultTextFill)}</text>`,
      );
      y += lineHeight;
    }
    if (idx < rows.length - 1) {
      y += 16;
    }
  });

  return { svg: elems.join('\n  '), height: cardH };
}

const COLS = 110;
const WIDTH_PX = 940;

const darkNormal = renderStatusline(
  { ...SAMPLE_PAYLOADS.normal, terminal_width: COLS },
  {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark', barStyle: 'smooth', colorMode: 'health' }),
    color: true,
    git: { branch: 'main', dirty: false },
    telemetry: SAMPLE_TELEMETRY.normal,
  },
).split('\n');

const darkWarning = renderStatusline(
  { ...SAMPLE_PAYLOADS.warning, terminal_width: COLS },
  {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark', barStyle: 'smooth', colorMode: 'health' }),
    color: true,
    git: { branch: 'feat/statusline', dirty: true },
    telemetry: SAMPLE_TELEMETRY.warning,
  },
).split('\n');

const darkCritical = renderStatusline(
  { ...SAMPLE_PAYLOADS.critical, terminal_width: COLS },
  {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-dark', barStyle: 'smooth', colorMode: 'health' }),
    color: true,
    git: { branch: 'feat/statusline', dirty: true },
    telemetry: SAMPLE_TELEMETRY.critical,
  },
).split('\n');

const darkCompact = renderStatusline(
  { ...SAMPLE_PAYLOADS.claude, terminal_width: COLS },
  {
    config: normalizeConfig({ preset: 'compact', theme: 'nord', barStyle: 'smooth', colorMode: 'health' }),
    color: true,
    git: { branch: 'main', dirty: false },
    telemetry: SAMPLE_TELEMETRY.claude,
  },
).split('\n');

const lightNormal = renderStatusline(
  { ...SAMPLE_PAYLOADS.normal, terminal_width: COLS },
  {
    config: normalizeConfig({ preset: 'dashboard', theme: 'slate-light', barStyle: 'smooth', colorMode: 'health' }),
    color: true,
    git: { branch: 'main', dirty: true },
    telemetry: SAMPLE_TELEMETRY.normal,
  },
).split('\n');

const darkCard = buildSection({
  title: 'agy-bar · Dark Themes (slate-dark & nord)',
  subtitle: 'smooth 8-level gauges · unified health colors',
  bg: '#0f172a',
  border: '#1e293b',
  titleFill: '#e2e8f0',
  subFill: '#64748b',
  defaultTextFill: '#e8ecf2',
  yStart: 18,
  widthPx: WIDTH_PX,
  rows: [
    { label: 'DASHBOARD · HEALTHY (Gemini 4 Neon · 5-min cache TTL + tok/s)', lines: darkNormal },
    { label: 'DASHBOARD · WARNING (Vim NORMAL badge · amber context & 5h quota · 1m08s cache TTL)', lines: darkWarning },
    { label: 'DASHBOARD · CRITICAL (danger red · →/compact hint · 18s cache TTL)', lines: darkCritical },
    { label: 'COMPACT · SINGLE-LINE (nord theme · Claude Sonnet 4.6)', lines: darkCompact },
  ],
});

const lightCard = buildSection({
  title: 'agy-bar · Light Theme (slate-light)',
  subtitle: 'auto-matched from AGY colorScheme',
  bg: '#f8fafc',
  border: '#cbd5e1',
  titleFill: '#0f172a',
  subFill: '#64748b',
  defaultTextFill: '#18202c',
  yStart: 18 + darkCard.height + 18,
  widthPx: WIDTH_PX,
  rows: [{ label: 'DASHBOARD · DAYLIGHT', lines: lightNormal }],
});

const totalHeight = 18 + darkCard.height + 18 + lightCard.height + 20;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH_PX}" height="${totalHeight}" viewBox="0 0 ${WIDTH_PX} ${totalHeight}" role="img" aria-label="agy-bar statusline preview">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#020617"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH_PX}" height="${totalHeight}" rx="16" fill="url(#bg-grad)"/>
  ${darkCard.svg}
  ${lightCard.svg}
</svg>
`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, svg, 'utf8');
console.log(`Generated ${OUTPUT_PATH} (${WIDTH_PX}x${totalHeight})`);

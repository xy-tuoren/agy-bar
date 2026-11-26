#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateStats, formatStatsReport } from '../src/stats.mjs';

const OUTPUT_PATH = fileURLToPath(new URL('../assets/stats-preview.svg', import.meta.url));

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

// Deterministic sample dataset showcasing 52-week activity heatmap, 4-card overview, and model breakdown.
const NOW = new Date('2026-11-26T16:00:00Z').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const entries = [];

// Deterministic multi-day developer activity across the last 36 weeks (realistic GitHub-style heatmap).
const seedPattern = [];
for (let daysAgo = 250; daysAgo >= 0; daysAgo--) {
  const hash = ((daysAgo * 2654435761) >>> 0) % 100;
  const isWeekend = (daysAgo + 2) % 7 === 0 || (daysAgo + 3) % 7 === 0;
  const activeChance = daysAgo < 14 ? 95 : daysAgo < 60 ? 78 : daysAgo < 150 ? 60 : 38;
  if (hash < (isWeekend ? activeChance * 0.55 : activeChance)) {
    const base = daysAgo < 10 ? 40 : daysAgo < 45 ? 24 : 12;
    const spike = hash % 11 === 0 ? 3.2 : hash % 5 === 0 ? 1.8 : 1;
    const weight = Math.max(3, Math.round((base + (hash % 22)) * spike));
    seedPattern.push([daysAgo, weight]);
  }
}

for (const [daysAgo, weight] of seedPattern) {
  const ts = NOW - daysAgo * DAY_MS - 3600_000;
  const turns = Math.max(2, Math.round(weight / 4));
  for (let t = 0; t < turns; t++) {
    const model = t % 5 === 0 ? 'Gemini 4 Carbon' : t % 7 === 0 ? 'Gemini 4 Hydrogen' : 'Gemini 4 Neon';
    const scale = weight * 140_000;
    entries.push({
      ts: ts + t * 180_000,
      session: `demo-${daysAgo}-${t % 3}`,
      source: t % 9 === 0 ? 'desktop' : 'cli',
      model,
      input: Math.round(scale * 0.12),
      output: Math.round(scale * 0.03),
      cacheRead: Math.round(scale * 0.85),
      cacheWrite: 0,
      thinking: Math.round(scale * 0.02),
      ttftMs: model.includes('Carbon') ? 6400 : model.includes('Hydrogen') ? 2200 : 3800,
      tokPerSec: model.includes('Hydrogen') ? 132 : model.includes('Carbon') ? 68 : 84,
    });
  }
}

const report = aggregateStats(entries, { period: '7d', now: NOW, sourceLabel: 'cli+desktop' });
const rendered = formatStatsReport(report, {
  color: true,
  theme: 'slate-dark',
  heatmapPalette: 'purple',
  now: NOW,
  columns: 118,
  env: { COLORTERM: 'truecolor' },
});

const lines = rendered.split('\n');
const WIDTH_PX = 980;
const LINE_H = 18.5;
const HEADER_H = 44;
const PAD_X = 24;
const PAD_Y = 18;
const CARD_H = Math.ceil(HEADER_H + lines.length * LINE_H + PAD_Y * 2);
const TOTAL_H = CARD_H + 36;

const elems = [];
elems.push(`<rect x="20" y="18" width="${WIDTH_PX - 40}" height="${CARD_H}" rx="12" fill="#0f172a" stroke="#1e293b" stroke-width="1"/>`);
elems.push(`<circle cx="42" cy="40" r="5.5" fill="#ff5f57"/>`);
elems.push(`<circle cx="60" cy="40" r="5.5" fill="#febc2e"/>`);
elems.push(`<circle cx="78" cy="40" r="5.5" fill="#28c840"/>`);
elems.push(`<text x="98" y="44" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="12" font-weight="600" fill="#e2e8f0">agy-bar stats · 52-Week Terminal Token Heatmap &amp; Cost Dashboard</text>`);
elems.push(`<text x="${WIDTH_PX - 44}" y="44" text-anchor="end" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="11" fill="#64748b">100% local read-only · zero web server</text>`);
elems.push(`<line x1="20" y1="58" x2="${WIDTH_PX - 20}" y2="58" stroke="#1e293b" stroke-width="1"/>`);

let y = 18 + HEADER_H + 20;
for (const line of lines) {
  elems.push(
    `<text x="${20 + PAD_X}" y="${y}" xml:space="preserve" font-family="'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="12">${ansiToTspans(line, '#e8ecf2')}</text>`,
  );
  y += LINE_H;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH_PX}" height="${TOTAL_H}" viewBox="0 0 ${WIDTH_PX} ${TOTAL_H}" role="img" aria-label="agy-bar stats 52-week terminal heatmap preview">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#020617"/>
      <stop offset="100%" stop-color="#0b1120"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH_PX}" height="${TOTAL_H}" rx="16" fill="url(#bg-grad)"/>
  ${elems.join('\n  ')}
</svg>
`;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, svg, 'utf8');
console.log(`Generated ${OUTPUT_PATH} (${WIDTH_PX}x${TOTAL_H})`);

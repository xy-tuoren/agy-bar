const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_REGEX, '');
}

export function sanitizeText(value) {
  return stripAnsi(String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export function rgbToAnsi256(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  const cr = clamp(r);
  const cg = clamp(g);
  const cb = clamp(b);

  // Nearest 6x6x6 xterm color cube index (16..231).
  const levels = [0, 95, 135, 175, 215, 255];
  const nearestCube = (val) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < levels.length; i++) {
      const d = Math.abs(val - levels[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
  const ri = nearestCube(cr);
  const gi = nearestCube(cg);
  const bi = nearestCube(cb);
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist =
    (cr - levels[ri]) ** 2 + (cg - levels[gi]) ** 2 + (cb - levels[bi]) ** 2;

  // Nearest 24-step xterm grayscale ramp index (232..255).
  const avg = (cr + cg + cb) / 3;
  const grayStep = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const grayVal = 8 + grayStep * 10;
  const grayIdx = 232 + grayStep;
  const grayDist = (cr - grayVal) ** 2 + (cg - grayVal) ** 2 + (cb - grayVal) ** 2;

  return grayDist < cubeDist ? grayIdx : cubeIdx;
}

export function detectColorDepth(env = process.env) {
  if (!env || typeof env !== 'object') return 'truecolor';
  if ('NO_COLOR' in env) return 'none';
  const term = String(env.TERM || '').trim().toLowerCase();
  if (term === 'dumb') return 'none';

  const colorterm = String(env.COLORTERM || '').trim().toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';

  const termProgram = String(env.TERM_PROGRAM || '').trim();
  if (termProgram === 'Apple_Terminal') return '256';

  if (
    env.WT_SESSION ||
    env.KITTY_WINDOW_ID ||
    env.KONSOLE_VERSION ||
    env.VTE_VERSION ||
    env.DOMTERM ||
    /^(?:ghostty|iterm\.app|wezterm|vscode|hyper|tabby|warpterminal|alacritty|rio|contour)$/i.test(termProgram) ||
    /(?:direct|kitty|ghostty|alacritty|wezterm)/.test(term)
  ) {
    return 'truecolor';
  }

  if (/(?:^|-)(?:256color)$/.test(term)) return '256';
  return 'truecolor';
}

export function fg(text, rgb, enabled = true) {
  if (!enabled || enabled === 'none' || !rgb || !text) return String(text ?? '');
  const [r, g, b] = rgb;
  if (enabled === '256') {
    return `\x1b[38;5;${rgbToAnsi256(r, g, b)}m${text}\x1b[0m`;
  }
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function bold(text, enabled = true) {
  if (!enabled || !text) return String(text ?? '');
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text, enabled = true) {
  if (!enabled || !text) return String(text ?? '');
  return `\x1b[2m${text}\x1b[22m`;
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0;
  // Wide CJK, astral emoji, & BMP Emoji_Presentation symbols (e.g. ⚡ U+26A1)
  if (
    cp > 0xffff ||
    cp === 0x26a1 ||
    cp === 0x231a ||
    cp === 0x231b ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    width += charWidth(ch);
  }
  return width;
}

export function clipPlain(text, maxWidth) {
  if (maxWidth <= 0) return '';
  let out = '';
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const w = charWidth(ch);
    if (width + w > maxWidth) break;
    out += ch;
    width += w;
  }
  return out;
}

export function clipAnsi(text, maxWidth) {
  if (maxWidth <= 0) return '';
  const input = String(text ?? '');
  let out = '';
  let width = 0;
  let hasAnsi = false;
  let i = 0;

  while (i < input.length) {
    if (input[i] === '\x1b' && input[i + 1] === '[') {
      const end = input.indexOf('m', i + 2);
      if (end !== -1) {
        out += input.slice(i, end + 1);
        hasAnsi = true;
        i = end + 1;
        continue;
      }
    }
    const cp = input.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(ch);
    if (width + w > maxWidth) break;
    out += ch;
    width += w;
    i += ch.length;
  }

  return hasAnsi && !out.endsWith('\x1b[0m') ? `${out}\x1b[0m` : out;
}

export function padDisplayEnd(text, targetWidth) {
  const str = String(text ?? '');
  const w = visibleWidth(str);
  if (w >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - w);
}

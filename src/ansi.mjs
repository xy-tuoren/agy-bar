const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_REGEX, '');
}

export function sanitizeText(value) {
  return stripAnsi(String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export function fg(text, rgb, enabled = true) {
  if (!enabled || !rgb || !text) return String(text ?? '');
  const [r, g, b] = rgb;
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
  // Wide CJK & emoji ranges
  if (
    cp > 0xffff ||
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

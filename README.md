# agy-bar

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A **zero-dependency, modern minimal dashboard statusline** for **Antigravity CLI (`agy`)** — featuring live context & quota gauges, prompt cache hit rate, Git branch/dirty status, curated themes, and adaptive narrow-width degradation.

```text
? for shortcuts · git:main*                                                 Gemini 4 Carbon · high
CTX ███░░░░░ 42.6% (1.0M) │ CACHE 88%              5h █████░ 85% (2h30m) │ 7d ████░░ 64% (3d)
```

---

## Highlights

- **Visual Gauges & Smart Thresholds** — Progress bars for context usage and 5h / weekly quotas with automatic color escalation (healthy → warning → danger).
- **Zero Dependencies & Offline-Only** — Pure Node.js ESM (`>= 20.0.0`). Reads only the `stdin` JSON payload provided by `agy` plus local `.git/HEAD` (optional dirty check). Never makes network calls or inspects conversation content.
- **Responsive Layout** — Automatically sheds secondary details (reset countdowns → bars → cache → capacity) as terminal width shrinks so lines never wrap or break the TUI.
- **3 Layout Presets** — `dashboard` (2-line HUD), `compact` (dense 1-line bar), and `minimal` (bare essentials).
- **6 Built-in Themes** — `auto` (detects `agy` `colorScheme` & terminal background), `slate-dark`, `slate-light`, `ocean`, `nord`, and `mono` (plus automatic `NO_COLOR` support).
- **Safe Install / Uninstall** — Automatically backs up your previous `statusLine` in `~/.gemini/antigravity-cli/settings.json` and restores it cleanly on uninstall.
- **Companion `/agy-bar` Skill** — Optional Antigravity skill installed automatically so you can adjust presets, themes, and toggles using natural language inside `agy`.

---

## Quick Start

Requires **Node.js >= 20.0.0** and **Antigravity CLI (`agy`)**.

### Option 1: From GitHub (recommended)

```sh
git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
cd ~/agy-bar
node bin/agy-bar.mjs install
```

### Option 2: Via `npx` (once published to npm)

```sh
npx agy-bar install
```

Then **restart `agy`** to see your new statusline (in an existing session, run `/skills reload` to pick up `/agy-bar`).

Pass `--no-skill` if you prefer not to register the companion `/agy-bar` skill:

```sh
node bin/agy-bar.mjs install --no-skill
```

---

## Customization

### Live Terminal Preview

Inspect any preset, theme, bar style, or terminal width before changing your config:

```sh
node bin/agy-bar.mjs preview --scenario all --width 100
node bin/agy-bar.mjs preview --preset compact --theme nord --bar-style line --width 84
```

### CLI Configuration

All changes are saved to `~/.gemini/config/agy-bar/config.json` and take effect on the next statusline refresh (no `agy` restart needed):

```sh
# Layout presets: dashboard | compact | minimal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config preset compact

# Themes: auto | slate-dark | slate-light | ocean | nord | mono
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config theme ocean

# Gauge styles: blocks (██░░) | line (━━──) | ascii ([##--])
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config bar-style line

# Toggle individual items
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config disable git cache
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config enable reset capacity

# Tune bar width & alert thresholds
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set barWidth 8 contextWarn 75 quotaDanger 10

# Inspect or reset
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config show
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config reset
```

### Natural Language Inside `agy`

With the companion skill installed, just ask `agy`:

- `/agy-bar switch to compact preset with nord theme`
- `/agy-bar hide git and reset countdowns`
- `/agy-bar use line bar style`

---

## Diagnostics, Update & Uninstall

```sh
# Run health checks & render self-test
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs doctor

# Update from git clone (preserves your config & original statusLine backup)
cd ~/agy-bar && git pull && node bin/agy-bar.mjs install

# Uninstall & restore previous statusLine setting
node ~/agy-bar/bin/agy-bar.mjs uninstall

# Uninstall + remove skill + delete config directory
node ~/agy-bar/bin/agy-bar.mjs uninstall --remove-skill --purge
```

---

## Privacy & Architecture

- **No network access**: `agy-bar` makes zero HTTP requests.
- **Read-only local metadata**: Context, cache, and quota values come exclusively from AGY's documented `statusLine` `stdin` payload. Git status reads `.git/HEAD` directly and runs a bounded `git status --porcelain --untracked-files=no` (120ms timeout) only when `show.git` is enabled.
- **Fault tolerant**: Malformed JSON or missing fields always degrade gracefully to a safe fallback string with exit code `0`.

## Development

```sh
npm test        # Run Node.js built-in test suite
npm run preview # Preview default statusline in terminal
npm run doctor  # Verify local installation
```

## License

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)

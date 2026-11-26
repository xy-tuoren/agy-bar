# agy-bar

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A **zero-dependency, 100% native Antigravity CLI (`agy`) statusline & telemetry toolkit** — built for CLI-first developers who want live context & quota gauges, **5-minute prompt cache expiry countdown**, **real-time `tok/s` speed**, **local usage & cost ledger (`agy-bar stats`)**, and a **multi-CLI live monitor (`agy-bar monitor`)** without ever patching desktop binaries.

```text
? for shortcuts · git:main                                                            Gemini 4 Carbon · high
CTX ███░░░░░ 42.6% (1.0M) │ CACHE 88%·3m42s │ 142t/s                 5h █████░ 85% (2h30m) │ 7d ████░░ 64% (3d)
```

---

## Why `agy-bar`? (Zero-Risk, CLI-Native Design)

- **100% Official `statusLine` Hook** — Zero binary patching, zero Electron injection, zero proxy interception, zero account credential access. Survives every Antigravity update cleanly with zero ban risk.
- **No Desktop App Required** — Works natively in standalone `agy` terminals, SSH/remote boxes, WSL, and multi-CLI workflows.
- **Ultra-Fast Hot Path** — Zero runtime dependencies, O(1) per-session state updates; heavy analytics stay isolated in dedicated `stats` / `monitor` commands so typing never lags.

---

## Key Features

- **Visual Context & Quota Gauges** — Progress bars (`blocks` / `line` / `ascii`) for context window and 5h / 7d quotas across **Gemini 4 Carbon / Hydrogen / Neon / Argon** and **Claude** pools, with per-model warning/danger thresholds.
- **5-Minute Prompt Cache TTL Countdown** — Shows cache hit rate plus remaining cache freshness (`CACHE 88%·3m42s`), turning amber (`<= 90s`) and red (`<= 30s` / `exp`) so you can keep warm cache alive instead of burning quota on rebuilds.
- **Live Output Speed (`tok/s`) & Context Delta (`Δ`)** — Tracks per-turn generation speed (`142t/s`) and optional context growth (`+12.4K`) directly from `agy`'s `statusLine` updates.
- **Local Usage & Cost Ledger (`agy-bar stats`)** — Aggregates `today` / `7d` / `30d` / `all` token totals, cache hit rate, average `tok/s`, **estimated public API cost & cache savings**, daily bar charts, and net observed quota Δ (handy for shared/carpool quota tracking).
- **Multi-CLI Live Monitor (`agy-bar monitor`)** — Terminal HUD tracking all active `agy` sessions side by side (state, workspace/branch, model, context gauge, cache TTL, speed, and global quotas).
- **3 Presets × 6 Themes × Narrow-Width Adaptation** — `dashboard` / `compact` / `minimal` presets; `auto` / `slate-dark` / `slate-light` / `ocean` / `nord` / `mono` themes; automatic progressive shedding so lines never wrap.
- **Safe Install / Uninstall + `/agy-bar` Skill** — Backs up your previous `statusLine`, restores cleanly on uninstall, and optionally registers the `/agy-bar` skill for natural-language configuration.

---

## Quick Start

Requires **Node.js >= 20.0.0** and **Antigravity CLI (`agy`)**.

### Option 1: Let `agy` install it for you

Paste this into an `agy` chat:

```text
Please follow https://github.com/xy-tuoren/agy-bar/blob/main/AGENTS.md to install agy-bar for me.
```

### Option 2: Manual install (GitHub)

```sh
git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
cd ~/agy-bar
node bin/agy-bar.mjs install
```

### Option 3: Via `npx` (once published to npm)

```sh
npx agy-bar install
```

Then **restart `agy`** to see the new statusline (in an existing session, run `/skills reload` to load `/agy-bar`). Use `--no-skill` to skip skill installation.

---

## Commands & Customization

### Preview, Stats & Multi-CLI Monitor

```sh
# Preview scenarios, presets, themes & widths right in your terminal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --scenario all --width 112
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --preset compact --theme nord --bar-style line

# View local usage statistics, cache savings & estimated API cost
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats today
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 7d --model claude
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 30d --json

# Monitor multiple concurrent agy CLI terminals live
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor --once
```

### Configuration (Takes effect immediately without restarting `agy`)

```sh
# Layout presets: dashboard | compact | minimal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config preset compact

# Themes: auto | slate-dark | slate-light | ocean | nord | mono
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config theme ocean

# Gauge styles: blocks (██░░) | line (━━──) | ascii ([##--])
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config bar-style line

# Toggle items (hint, model, effort, git, gitDirty, context, contextBar, contextDelta, capacity, cache, cacheTtl, speed, quota, quotaBar, quota5h, quotaWeekly, reset)
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config enable contextDelta
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config disable git speed

# Set per-model context warning thresholds, cache TTL, or disable local ledger
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set cacheTtlSec 300 ledger on

# Diagnostics, inspect & reset
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs doctor
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config show
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config reset
```

### Update & Uninstall

```sh
# Update (preserves your config, ledger & original statusLine backup)
cd ~/agy-bar && git pull && node bin/agy-bar.mjs install

# Uninstall & restore previous statusLine
node ~/agy-bar/bin/agy-bar.mjs uninstall

# Complete cleanup (also removes /agy-bar skill & ~/.gemini/config/agy-bar)
node ~/agy-bar/bin/agy-bar.mjs uninstall --remove-skill --purge
```

---

## Development

```sh
npm test         # Cross-platform Node.js built-in test suite
npm run preview  # Render live terminal preview
npm run stats    # Show local usage stats
npm run monitor  # Launch multi-CLI HUD
npm run doctor   # Verify local installation
```

## License

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)

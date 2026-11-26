# agy-bar

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A **zero-dependency, 100% native Antigravity CLI (`agy`) statusline & telemetry toolkit** — built for CLI-first developers who want **smooth 8-level context & quota gauges**, **5-minute prompt cache expiry countdown**, **real-time `tok/s` speed**, **local usage & cost ledger (`agy-bar stats`)**, and a **multi-CLI live monitor (`agy-bar monitor`)** without ever patching desktop binaries.

![agy-bar true-color preview](./assets/preview.svg)

---

## Why `agy-bar`? (Zero-Risk, CLI-Native Design)

- **100% Official `statusLine` Hook** — Zero binary patching, zero Electron injection, zero proxy interception, zero account credential access. Survives every Antigravity update cleanly with zero ban risk.
- **No Desktop App Required** — Works natively in standalone `agy` terminals, SSH/remote servers, WSL, and multi-CLI workflows.
- **Ultra-Fast Hot Path** — Zero runtime dependencies, O(1) per-session state updates; heavy analytics stay isolated in `stats` / `monitor` commands so typing never lags.

---

## Key Features

- **Unified Health Colors & Smooth 8-Level Gauges** — Context (`CTX`) and quota (`5h` / `7d`) bars share one cohesive `green → amber → red` health palette (`colorMode: health | distinct`), rendered with 1/8-block Unicode precision (`smooth`, `blocks`, `line`, `ascii`) across **Gemini 4 Carbon / Hydrogen / Neon / Argon** and **Claude** pools.
- **5-Minute Prompt Cache TTL Countdown** — Displays cache hit rate + remaining freshness (`CACHE 88%·3m42s`), shifting to amber (`<= 90s`) and red (`<= 30s` / `exp`) so you avoid burning quota on cold cache rebuilds.
- **Smart Workspace, Vim & `/compact` Signals** — Line 1 pairs folder name with Git branch (`agy-bar (main*)`) and automatic `[NORMAL]` / `[INSERT]` Vim badges; line 2 adds an actionable `→/compact` hint when context hits your danger threshold.
- **Exact First-Token Latency (`TTFT`), Streaming Speed (`tok/s`), Cost (`~$0.42`) & Delta (`+12.4K`)** — Displays first-token wait time (`TTFT 1.9s·158t/s`) separated cleanly from pure streaming decode speed (via read-only numeric step timestamps on Node 22.13+ with pure-`stdin` fallback on Node 20; toggleable via `dbTiming`), plus opt-in live session cost, duration/turns, and context delta.
- **Local Usage & Cost Ledger (`agy-bar stats`)** — Aggregates `today` / `7d` / `30d` / `all` tokens, cache hit rate, average `tok/s`, **estimated public API cost & cache savings**, daily bar charts, and net observed quota Δ (handy for shared/carpool tracking).
- **Multi-CLI Live Monitor (`agy-bar monitor`)** — Terminal HUD tracking all concurrent `agy` sessions side by side.
- **Redacted Payload Debugger (`agy-bar debug`)** — Captures a one-shot PII-redacted AGY JSON payload for easy troubleshooting across AGY CLI updates.
- **Safe Install / Uninstall + `/agy-bar` Skill** — Backs up your previous `statusLine`, restores cleanly on uninstall, and optionally installs the `/agy-bar` skill.

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

### Preview, Stats, Monitor & Debug

```sh
# Preview scenarios, presets, themes & gauge styles
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --scenario all --width 116
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs preview --preset compact --theme nord --bar-style smooth

# Local usage statistics, cache savings & estimated API cost
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats today
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 7d --model claude
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs stats 30d --json

# Live multi-CLI HUD
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs monitor --once

# Capture & inspect a PII-redacted live AGY payload
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs debug --capture
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs debug
```

### Configuration (Takes effect immediately without restarting `agy`)

```sh
# Presets: dashboard | compact | minimal
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config preset compact

# Themes: auto | slate-dark | slate-light | ocean | nord | mono
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config theme ocean

# Gauge styles: smooth (███▍░░) | blocks (███░░░) | line (━━━───) | ascii ([###---])
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config bar-style smooth

# Color mode: health (unified green->amber->red) | distinct (blue CTX vs green quota)
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config set colorMode health

# Toggle items (dir, vim, git, gitDirty, contextDelta, compactHint, cacheTtl, speed, cost, session, reset, ...)
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config enable cost session contextDelta
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config disable dir speed

# Per-model context thresholds, cache TTL, or ledger toggle
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
npm run preview:svg # Regenerate assets/preview.svg
npm run stats    # Show local usage stats
npm run monitor  # Launch multi-CLI HUD
npm run doctor   # Verify local installation
```

## License

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)

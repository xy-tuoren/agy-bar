# agy-bar

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A **zero-dependency, 100% native Antigravity CLI (`agy`) statusline & telemetry toolkit** — built for CLI-first developers who want **smooth 8-level context & quota gauges**, **5-minute prompt cache expiry countdown**, **real-time `tok/s` speed**, **local usage & cost ledger (`agy-bar stats`)**, and a **multi-CLI live monitor (`agy-bar monitor`)** without ever patching desktop binaries.

![agy-bar true-color preview](./assets/preview.svg)

![agy-bar 52-week terminal token heatmap preview](./assets/stats-preview.svg)

---

## Why `agy-bar`? (Zero-Risk, CLI-Native Design)

- **100% Official `statusLine` Hook** — Zero binary patching, zero Electron injection, zero proxy interception, zero account credential access. Survives every Antigravity update cleanly with zero ban risk.
- **No Desktop App Required** — Works natively in standalone `agy` terminals, SSH/remote servers, WSL, and multi-CLI workflows.
- **Ultra-Fast Hot Path** — Zero runtime dependencies, O(1) per-session state updates; heavy analytics stay isolated in `stats` / `monitor` commands so typing never lags.

---

## Key Features

- **Unified Health Colors & Smooth 8-Level Gauges** — Context (`CTX`) and quota (`5h` / `7d`) bars share one cohesive `green → amber → red` health palette (`colorMode: health | distinct`), rendered with 1/8-block Unicode precision (`smooth`, `blocks`, `line`, `ascii`) across **Gemini 4 Carbon / Hydrogen / Neon / Argon** and **Claude** pools.
- **5-Minute Prompt Cache TTL Countdown** — Displays cache hit rate + remaining freshness (`CACHE 88%·3m42s`), shifting to amber (`<= 90s`) and red (`<= 30s` / `exp`) so you avoid burning quota on cold cache rebuilds.
- **Smart Workspace, Proxy & On-Demand Work-State Signals** — Line 1 pairs folder + Git branch (`agy-bar (main*)`) with an automatic active-proxy port badge (`PX 7897`, zero network) and zero-clutter dynamic badges that appear only when needed: live busy turn timer (`esc to cancel · 34s`), running parallel subagent count (`⚡2`), `PLAN` / `SANDBOX` mode badges, and Vim `[NORMAL]` / `[INSERT]`; line 2 adds an actionable `→/compact` hint when context hits danger.
- **Exact First-Token Latency (`TTFT`), Streaming Speed (`tok/s`), Live Chat/Day Cost (`CHAT ~$1.24 · DAY $13.18`) & Delta (`+12.4K`)** — Displays first-token wait time (`TTFT 1.9s·158t/s`) separated cleanly from pure streaming decode speed (via read-only numeric step timestamps on Node 22.13+ with pure-`stdin` fallback on Node 20; toggleable via `dbTiming`), pairs **this conversation's estimated spend + today's estimated cost** right beside the `5h` quota gauge (`show.cost`, `show.todayCost`), plus opt-in session duration/turns and context delta.
- **Full-History Terminal Token Dashboard & Heatmap (`agy-bar stats`)** — Incrementally scans local Antigravity CLI & Desktop conversation DBs in read-only mode (never reads chat text; `< 20ms` cached) to render an **All-Time / Today / Month / Year 4-card overview**, a **52-week true-color terminal activity heatmap** (`purple` / `green` / `cyan` / `amber`), streaks, per-model TTFT/speed breakdown, CLI vs Desktop split, **estimated API cost & cache savings**, and net observed quota Δ.
- **Automatic Terminal Tab Title Sync (`● working` / `✓ idle`)** — Replaces identical `agy --dangerously-skip-permissions` tabs in Ghostty / iTerm2 / Kitty / WezTerm / macOS Terminal with live state + concise conversation title via standard OSC 0 (zero extra tokens). Supports `agy-bar title "<short topic>"` so your Agent can summarize topic shifts in ~10 tokens with zero extra API calls.
- **No-TUN Proxy Launcher (`agy-bar run` & `agy-bar proxy`)** — Launch `agy` directly through your local Clash / Clash Verge / Surge / v2ray HTTP proxy **without enabling TUN mode**. Auto-detects macOS/Windows system proxies or active localhost proxy ports (`7897`, `7890`, `6152`, `10809`, `1087`, ...), injects standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` + loopback-safe `NO_PROXY`, and installs a global `~/.local/bin/agy-bar` shortcut alongside `agy`.
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

`install` automatically places the `agy-bar` command at `~/.local/bin/agy-bar` (right next to `agy`), so you can run `agy-bar ...` directly from any terminal.

### Launch `agy` Through Local Proxy Without TUN

During interactive `install`, `agy-bar` clearly explains and asks (`[y/N]`) whether you want to add a reversible 7-line managed `agy()` shell hook to `~/.zshrc` / `~/.bashrc` / `config.fish` (non-interactive installs leave your shell rc untouched by default unless `--proxy-hook` is passed). Once enabled (or via `agy-bar run` without any shell rc changes):

```sh
# With the optional shell hook enabled — just type plain agy (no TUN needed!)
agy
agy -c --dangerously-skip-permissions

# Or launch explicitly via agy-bar run (zero changes to ~/.zshrc)
agy-bar run -c

# Pin your detected local proxy permanently, or set one manually
agy-bar proxy auto
agy-bar proxy set http://127.0.0.1:7897

# Inspect effective proxy, shell hook & live reachability, or toggle on/off
agy-bar proxy status
agy-bar proxy off
agy-bar proxy hook      # opt in to plain "agy" shell hook anytime
agy-bar proxy unhook    # remove shell hook cleanly

# One-shot direct bypass (no proxy) or shell env export
command agy -c          # or: AGY_BAR_NO_PROXY=1 agy -c
eval "$(agy-bar proxy env)"
```

### Preview, Stats, Monitor & Debug

```sh
# Preview scenarios, presets, themes & gauge styles
agy-bar preview --scenario all --width 116
agy-bar preview --preset compact --theme nord --bar-style smooth

# Full-history token dashboard, 52-week terminal heatmap & estimated API cost
agy-bar stats
agy-bar stats 30d --palette green --source cli
agy-bar stats all --model neon --json

# Live multi-CLI HUD
agy-bar monitor
agy-bar monitor --once

# Capture & inspect a PII-redacted live AGY payload
agy-bar debug --capture
agy-bar debug

# Set, inspect, or clear the current terminal tab title (works in Ghostty, iTerm2, Kitty, WezTerm, Terminal)
agy-bar title "agy-bar v0.7 dev"
agy-bar title
agy-bar title --clear
```

> **Optional: Auto-summarize tab titles on topic shifts (~10 tokens, zero extra API calls)**
> Add this one line to your global `~/.gemini/antigravity-cli/AGENTS.md` (or project `AGENTS.md`):
> ```text
> When the user starts a clearly new task/topic in a long session, silently run `agy-bar title "<4-8 word concise topic>"` once to keep the terminal tab title up to date.
> ```

### Configuration (Takes effect immediately without restarting `agy`)

```sh
# Presets: dashboard | compact | minimal
agy-bar config preset compact

# Themes: auto | slate-dark | slate-light | ocean | nord | mono
agy-bar config theme ocean

# Gauge styles: segments (▮▮▮▯▯▯, default) | squares (■■■□□□) | pills (▰▰▰▱▱▱) | dots (●●●○○○) | smooth | blocks | line | ascii
agy-bar config bar-style segments

# Color mode: health (unified green->amber->red) | distinct (blue CTX vs green quota)
agy-bar config set colorMode health

# Toggle items (dir, vim, git, gitDirty, contextDelta, compactHint, cacheTtl, speed, cost, session, reset, ...)
agy-bar config enable cost session contextDelta
agy-bar config disable dir speed

# Per-model context thresholds, cache TTL, or ledger toggle
agy-bar config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85
agy-bar config set cacheTtlSec 300 ledger on

# Diagnostics, inspect & reset
agy-bar doctor
agy-bar config show
agy-bar config reset
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

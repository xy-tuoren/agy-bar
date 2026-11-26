# agy-bar

**English** | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/xy-tuoren/agy-bar/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agy-bar.svg)](https://www.npmjs.com/package/agy-bar)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A **zero-dependency, 100% native Antigravity CLI (`agy`) statusline & telemetry toolkit** — built for CLI-first developers who want **crisp segmented context & quota gauges**, **5-minute prompt cache expiry countdown**, **real-time TTFT & `tok/s` speed**, **live-synced API cost estimation (`agy-bar pricing`)**, **52-week token heatmap (`agy-bar stats`)**, **no-TUN proxy launching (`agy-bar run`)**, and a **multi-CLI live monitor (`agy-bar monitor`)** without ever patching desktop binaries.

![agy-bar true-color preview](https://raw.githubusercontent.com/xy-tuoren/agy-bar/main/assets/preview.svg)

![agy-bar 52-week terminal token heatmap preview](https://raw.githubusercontent.com/xy-tuoren/agy-bar/main/assets/stats-preview.svg)

---

## Why `agy-bar`? (Zero-Risk, CLI-Native Design)

- **100% Official `statusLine` Hook** — Zero binary patching, zero Electron injection, zero Google/AGY private API calls, zero account credential access. Statusline rendering itself never touches the network; only an optional 24-hour background sync fetches public unauthenticated reference pricing JSON from `models.dev` / `LiteLLM` (disable anytime via `agy-bar config set pricingAutoSync off` for strict offline mode).
- **No Desktop App Required** — Works natively in standalone `agy` terminals, SSH/remote servers, WSL, macOS, Linux, and Windows.
- **Ultra-Fast Hot Path** — Zero runtime dependencies, zero-subprocess idle refreshes, atomic writes, and O(1) per-session state updates so typing never lags.

---

## Key Features

- **Unified Health Colors & Crisp Segmented Gauges** — Context (`CTX`) and quota (`5h` / `7d`) bars share one cohesive `green → amber → red` health palette (`colorMode: health | distinct`), defaulting to cell-separated `segments` (`▮▮▮▯▯▯`) with 8 selectable styles (`segments`, `squares`, `pills`, `dots`, `smooth`, `blocks`, `line`, `ascii`) across **Gemini 4 Carbon / Hydrogen / Neon / Argon** and **Claude** pools.
- **5-Minute Prompt Cache TTL Countdown** — Displays cache hit rate + remaining freshness (`CACHE 88%·3m42s`), shifting to amber (`<= 90s`) and red (`<= 30s` / `exp`) so you avoid burning quota on cold cache rebuilds.
- **Calm Two-Line Layout, Live Git Diff (`+142 -38`) & On-Demand Signals** — Line 1 pairs compact workspace paths + live Git diff line counts (`~/code/agy-bar (main* +142 -38) · PX 7897`, covering tracked edits and new untracked text files with 3s caching; toggleable via `show.gitDiff` and `dirStyle: short | parent | name`) with neutral cumulative totals (`DAY 136M/$13.2 · WK 810M · MO 875M · ALL 906M │ Model`), lighting up dynamic badges only while busy (`● 34s · esc`, parallel subagents `⚡2`, `PLAN` / `SANDBOX`, Vim `[NORMAL]` / `[INSERT]`); line 2 keeps live session telemetry + conversation spend (`CTX · CACHE · TTFT·t/s · ~$0.18`) on the left and steady `5h` / `7d` account quotas on the right.
- **Exact First-Token Latency (`TTFT`), Streaming Speed (`tok/s`) & Live Pricing Sync (`agy-bar pricing`)** — Separates first-token wait time from pure streaming decode speed (`TTFT 1.9s·158t/s`, via read-only numeric step timestamps on Node 22.13+ with pure-`stdin` fallback on Node 20; toggleable via `dbTiming`). Reference USD estimates combine built-in calibrated rates with a 24h background `models.dev` / `LiteLLM` cache (proxy-aware, ETag `304`, custom overrides via `agy-bar pricing set`).
- **Full-History Terminal Token Dashboard & Heatmap (`agy-bar stats`)** — Incrementally scans local Antigravity CLI & Desktop conversation DBs in read-only mode (never reads chat text; `< 20ms` cached) to render an **80-col-friendly 4-card overview** (`All-Time / Today / Month / Year`), a **52-week terminal activity heatmap** (`purple` / `green` / `cyan` / `amber`, auto-adapted for dark & light themes), streaks, per-model TTFT/speed breakdown, CLI vs Desktop split, **estimated API cost & cache savings**, and net observed quota Δ.
- **Automatic Terminal Tab Title Sync (`● working` / `✓ idle`)** — Replaces identical `agy --dangerously-skip-permissions` tabs on macOS/Linux/WSL (Ghostty, iTerm2, Kitty, WezTerm, Terminal.app, VS Code) with live state + concise conversation title via standard OSC 0/2 (zero extra tokens; gracefully skipped on native Windows). Supports `agy-bar title "<short topic>"` so your Agent can summarize topic shifts in ~10 tokens with zero extra API calls.
- **No-TUN Proxy Launcher (`agy-bar run` & `agy-bar proxy`)** — Launch `agy` directly through your local Clash / Clash Verge / Surge / v2ray HTTP proxy **without enabling TUN mode**. Auto-detects macOS/Windows system proxies or active localhost proxy ports (`7897`, `7890`, `6152`, `10809`, `1087`, ...), injects standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` + loopback-safe `NO_PROXY`, and installs a global `~/.local/bin/agy-bar` shortcut alongside `agy`.
- **Multi-CLI Live Monitor (`agy-bar monitor`)** — Terminal HUD tracking all concurrent `agy` sessions side by side with CJK-safe column alignment and live cost.
- **Redacted Payload Debugger (`agy-bar debug`)** — Captures a one-shot PII-redacted AGY JSON payload for easy troubleshooting across AGY CLI updates.
- **Safe Install / Uninstall + `/agy-bar` Skill** — Backs up your previous `statusLine`, restores cleanly on uninstall, and optionally installs the `/agy-bar` skill.

---

## Quick Start

Requires **Node.js >= 20.0.0** and **Antigravity CLI (`agy`)**.

### Option 1: Via `npx` (Fastest)

```sh
npx agy-bar install
```

### Option 2: Let `agy` install it for you

Paste this into an `agy` chat:

```text
Please follow https://github.com/xy-tuoren/agy-bar/blob/main/AGENTS.md to install agy-bar for me.
```

### Option 3: Manual install (GitHub)

```sh
git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
cd ~/agy-bar
node bin/agy-bar.mjs install
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

# Full-history token dashboard, 52-week terminal heatmap & live-synced API cost
agy-bar stats
agy-bar stats 30d --palette green --source cli
agy-bar stats all --model neon --json

# Inspect, sync, or customize reference API pricing (24h background SWR auto-sync via public models.dev/LiteLLM; zero auth)
agy-bar pricing show
agy-bar pricing sync
agy-bar pricing set gemini-4-neon 3 15 0.15
agy-bar config set pricingAutoSync off   # opt out for strict offline mode

# Live multi-CLI HUD
agy-bar monitor
agy-bar monitor --once

# Capture & inspect a PII-redacted live AGY payload
agy-bar debug --capture
agy-bar debug

# Set, inspect, or clear the current terminal tab title (macOS/Linux/WSL: Ghostty, iTerm2, Kitty, WezTerm, Terminal)
agy-bar title "agy-bar release"
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

# Workspace path style: short (~/code/agy-bar, default) | parent (code/agy-bar) | name (agy-bar)
agy-bar config set dirStyle short

# Color mode: health (unified green->amber->red) | distinct (blue CTX vs green quota)
agy-bar config set colorMode health

# Toggle items (dir, vim, git, gitDirty, gitDiff, contextDelta, compactHint, cacheTtl, speed, cost, session, reset, ...)
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
npx agy-bar@latest install

# Uninstall & restore previous statusLine
npx agy-bar uninstall          # or: agy-bar uninstall

# Complete cleanup (also removes /agy-bar skill & ~/.gemini/config/agy-bar)
npx agy-bar uninstall --remove-skill --purge
```

---

## Terminal & OS Compatibility

- **Truecolor & 256-Color Terminals**: Emits 24-bit Truecolor in Ghostty, iTerm2, Kitty, WezTerm, Alacritty, Warp, VS Code, and Windows Terminal; automatically downscales to nearest xterm-256 colors in macOS `Terminal.app` (`Apple_Terminal`) and `tmux` / `screen` / SSH sessions without `COLORTERM=truecolor`, and respects `NO_COLOR` / `TERM=dumb`.
- **Light & Dark Themes**: Auto-adapts statusline and `agy-bar stats` heatmap ramps for both dark and light themes (`auto` / `slate-dark` / `slate-light` / `ocean` / `nord` / `mono`).
- **Windows Notes**: Supported on Windows Terminal, PowerShell 7 (`pwsh`), Windows PowerShell 5.1, and `cmd.exe` (including `.cmd` shims, Windows system proxy detection, and cached dark/light theme detection). Automatic OSC tab title sync is macOS/Linux/WSL only and is safely skipped on native Windows. On older ConHost fonts missing `▮`, switch with `agy-bar config bar-style squares` or `blocks`.

---

## Development

```sh
npm test            # Cross-platform Node.js built-in test suite
npm run preview     # Render live terminal preview
npm run preview:svg # Regenerate assets/preview.svg & assets/stats-preview.svg
npm run stats       # Show local usage stats
npm run pricing     # Inspect or sync model pricing cache
npm run monitor     # Launch multi-CLI HUD
npm run doctor      # Verify local installation
```

## License

[MIT](./LICENSE) © [xy-tuoren](https://github.com/xy-tuoren)

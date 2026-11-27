---
name: agy-bar
description: Inspect and customize the agy-bar statusline, launch agy through a local proxy without TUN mode, set concise terminal tab titles, check local CLI usage stats and estimated API costs, monitor concurrent CLI sessions, or debug payloads for Antigravity CLI. Use when the user asks to configure agy-bar, set up or check no-TUN proxy for agy, rename/summarize the terminal tab title, switch themes/presets/colorMode/barStyle, toggle items, or run stats/monitor/debug.
---
<!-- agy-bar: managed skill -->

# agy-bar Guide

Use the installed `agy-bar` CLI helper to manage `~/.gemini/config/agy-bar/config.json`, configure the no-TUN proxy launcher, update terminal tab titles, and inspect local telemetry. Never edit unrelated Antigravity CLI settings.

## CLI Entrypoint

```sh
agy-bar <command>   # installed at ~/.local/bin/agy-bar (or: node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs <command>)
```

## Common Commands

| Intent | Command |
| --- | --- |
| Launch `agy` via local proxy (no TUN) | Plain `agy [args...]` (via shell hook) or `agy-bar run [agy args...]` |
| Auto-detect / set / check no-TUN proxy | `agy-bar proxy auto` / `agy-bar proxy set http://127.0.0.1:7897` / `agy-bar proxy status` |
| Manage shell hook / toggle / exports | `agy-bar proxy hook\|unhook` / `agy-bar proxy on\|off` / `agy-bar proxy env` |
| Set concise tab title (~10 tokens) | `agy-bar title "<4-8 char concise topic>"` |
| Clear custom tab title | `agy-bar title --clear` |
| Configure tab title sync | `agy-bar config set tabTitle on\|off tabTitleSource auto\|title\|dir\|title+dir` |
| Show current settings | `agy-bar config show` |
| Switch preset / theme / bar style | `agy-bar config preset ...` / `agy-bar config theme ...` / `agy-bar config bar-style ...` |
| Switch gauge color mode / path style | `agy-bar config set colorMode health \| distinct` / `agy-bar config set dirStyle short \| parent \| name` |
| Show / hide elements | `agy-bar config enable cost session contextDelta` / `agy-bar config disable dir ttft speed` |
| Tune alerts, timing, or pricing sync | `agy-bar config set ttftWarnSec 8 ttftDangerSec 15 dbTiming on pricingAutoSync on\|off` |
| Full-history token heatmap & stats | `agy-bar stats [today\|7d\|30d\|all] [--source all\|cli\|desktop\|ledger] [--palette purple\|green\|cyan\|amber]` |
| Inspect, sync, or override model pricing | `agy-bar pricing show` / `agy-bar pricing sync` / `agy-bar pricing set <model> <in> <out> [cacheRead]` |
| Multi-CLI live monitor | `agy-bar monitor [--once]` |
| Redacted payload debug | `agy-bar debug --capture` then `agy-bar debug` |
| Preview / Diagnostics | `agy-bar preview --scenario all` / `agy-bar doctor` |
| Full uninstall + live shell cleanup | `eval "$(agy-bar uninstall --remove-skill --purge --print-cleanup)"` |

## Toggleable Items

`hint`, `vim`, `mode`, `subagents`, `turnTimer`, `proxy`, `dir`, `model`, `effort`, `git`, `gitDirty`, `gitDiff`, `context`, `contextBar`, `contextDelta`, `compactHint`, `capacity`, `cache`, `cacheTtl`, `ttft`, `speed`, `cost`, `todayCost`, `session`, `todayTokens`, `weekTokens`, `monthTokens`, `totalTokens`, `quota`, `quotaBar`, `quota5h`, `quotaWeekly`, `reset`

## Workflow

1. Run `agy-bar config show` (or `agy-bar proxy status`) first if current preferences are unclear.
2. When summarizing a terminal tab title, condense the active topic into 4–8 Chinese chars (or 3–5 English words) directly from current context and run `agy-bar title "<summary>"` without extra LLM calls.
3. Configuration changes take effect on the next statusline refresh without restarting `agy`.

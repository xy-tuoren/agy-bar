---
name: agy-bar
description: Inspect and customize the agy-bar statusline, set concise terminal tab titles, check local CLI usage stats and estimated API costs, monitor concurrent CLI sessions, or debug payloads for Antigravity CLI. Use when the user asks to configure agy-bar, rename/summarize the terminal tab title, switch themes/presets/colorMode/barStyle, toggle items, or run stats/monitor/debug.
---
<!-- agy-bar: managed skill -->

# agy-bar Guide

Use the installed `agy-bar` CLI helper to manage `~/.gemini/config/agy-bar/config.json`, update terminal tab titles, and inspect local telemetry. Never edit unrelated Antigravity CLI settings.

## CLI Entrypoint

```sh
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs <command>
```

## Common Commands

| Intent | Command |
| --- | --- |
| Set concise tab title (~10 tokens) | `... title "<4-8 char concise topic>"` |
| Clear custom tab title | `... title --clear` |
| Configure tab title sync | `... config set tabTitle on\|off tabTitleSource auto\|title\|dir\|title+dir` |
| Show current settings | `... config show` |
| Switch preset / theme / bar style | `... config preset ...` / `... config theme ...` / `... config bar-style ...` |
| Switch gauge color mode | `... config set colorMode health \| distinct` |
| Show / hide elements | `... config enable cost session contextDelta` / `... config disable dir ttft speed` |
| Tune alerts or timing | `... config set ttftWarnSec 8 ttftDangerSec 15 dbTiming on` |
| Usage & cost report | `... stats today \| 7d \| 30d \| all [--model claude]` |
| Multi-CLI live monitor | `... monitor [--once]` |
| Redacted payload debug | `... debug --capture` then `... debug` |
| Preview / Diagnostics | `... preview --scenario all` / `... doctor` |

## Toggleable Items

`hint`, `vim`, `dir`, `model`, `effort`, `git`, `gitDirty`, `context`, `contextBar`, `contextDelta`, `compactHint`, `capacity`, `cache`, `cacheTtl`, `ttft`, `speed`, `cost`, `session`, `quota`, `quotaBar`, `quota5h`, `quotaWeekly`, `reset`

## Workflow

1. Run `config show` first if current preferences are unclear.
2. When summarizing a terminal tab title, condense the active topic into 4–8 Chinese chars (or 3–5 English words) directly from current context and run `... title "<summary>"` without extra LLM calls.
3. Configuration changes take effect on the next statusline refresh without restarting `agy`.

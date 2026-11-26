---
name: agy-bar
description: Inspect and customize the agy-bar statusline, check local CLI usage stats and estimated API costs, monitor concurrent CLI sessions, or debug payloads for Antigravity CLI. Use when the user asks to configure agy-bar, switch themes/presets/colorMode/barStyle, toggle dir/vim/cost/session/compactHint/cacheTtl/speed, or run stats/monitor/debug.
---
<!-- agy-bar: managed skill -->

# agy-bar Guide

Use the installed `agy-bar` CLI helper to manage `~/.gemini/config/agy-bar/config.json` and inspect local telemetry. Never edit unrelated Antigravity CLI settings.

## CLI Entrypoint

```sh
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs <command>
```

## Common Commands

| Intent | Command |
| --- | --- |
| Show current settings | `... config show` |
| Switch layout preset | `... config preset dashboard \| compact \| minimal` |
| Switch color theme | `... config theme auto \| slate-dark \| slate-light \| ocean \| nord \| mono` |
| Switch bar style | `... config bar-style smooth \| blocks \| line \| ascii` |
| Switch gauge color mode | `... config set colorMode health \| distinct` |
| Show / hide elements | `... config enable cost session contextDelta` / `... config disable dir compactHint speed` |
| Per-model context alerts | `... config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85` |
| Usage & cost report | `... stats today \| 7d \| 30d \| all [--model claude]` |
| Multi-CLI live monitor | `... monitor [--once]` |
| Redacted payload debug | `... debug --capture` then `... debug` |
| Preview / Diagnostics | `... preview --scenario all` / `... doctor` |

## Toggleable Items

`hint`, `vim`, `dir`, `model`, `effort`, `git`, `gitDirty`, `context`, `contextBar`, `contextDelta`, `compactHint`, `capacity`, `cache`, `cacheTtl`, `speed`, `cost`, `session`, `quota`, `quotaBar`, `quota5h`, `quotaWeekly`, `reset`

## Workflow

1. Run `config show` first if current preferences are unclear.
2. Apply changes with one `config` command; changes take effect on the next statusline refresh without restarting `agy`.
3. For usage/cost questions, run `stats` and summarize concisely.

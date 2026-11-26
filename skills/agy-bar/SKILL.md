---
name: agy-bar
description: Inspect and customize the agy-bar statusline, check local CLI usage stats and estimated API costs, or inspect multi-CLI sessions for Antigravity CLI. Use when the user asks to configure agy-bar, switch themes or presets, toggle cache TTL/speed/git/delta items, set per-model context thresholds, or check CLI token stats.
---
<!-- agy-bar: managed skill -->

# agy-bar Guide

Use the installed `agy-bar` CLI helper to manage `~/.gemini/config/agy-bar/config.json` and query local telemetry. Never edit unrelated Antigravity CLI settings.

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
| Change gauge bar style | `... config bar-style blocks \| line \| ascii` |
| Show / hide elements | `... config enable contextDelta` / `... config disable git cacheTtl speed` |
| Per-model context alerts | `... config set modelThreshold.claude.warn 65 modelThreshold.claude.danger 85` |
| Tune TTL or ledger | `... config set cacheTtlSec 300 ledger on` |
| Usage & cost report | `... stats today \| 7d \| 30d \| all [--model claude]` |
| Multi-CLI live monitor | `... monitor [--once]` |
| Preview in terminal | `... preview --scenario all --width 112` |
| Diagnostics | `... doctor` |

## Toggleable Items

`hint`, `model`, `effort`, `git`, `gitDirty`, `context`, `contextBar`, `contextDelta`, `capacity`, `cache`, `cacheTtl`, `speed`, `quota`, `quotaBar`, `quota5h`, `quotaWeekly`, `reset`

## Workflow

1. Run `config show` first if current preferences are unclear.
2. Apply changes with one `config` command; changes take effect on the next statusline refresh without restarting `agy`.
3. For usage/cost questions, run `stats` and summarize cleanly.

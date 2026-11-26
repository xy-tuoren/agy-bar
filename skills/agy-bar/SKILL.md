---
name: agy-bar
description: Inspect and customize the agy-bar statusline layout preset, theme, gauge bar style, warning thresholds, and item toggles for Antigravity CLI. Use when the user asks to configure agy-bar, switch statusline themes or presets, hide or show Git/cache/quota/reset items, or preview statusline changes.
---
<!-- agy-bar: managed skill -->

# agy-bar Configuration Guide

Use the installed `agy-bar` CLI helper to inspect or update `~/.gemini/config/agy-bar/config.json`. Never edit unrelated Antigravity CLI settings.

## CLI Entrypoint

```sh
node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs <command>
```

## Common Commands

| Intent | Command |
| --- | --- |
| Show current settings | `node ~/.gemini/config/agy-bar/app/bin/agy-bar.mjs config show` |
| Switch layout preset | `... config preset dashboard \| compact \| minimal` |
| Switch color theme | `... config theme auto \| slate-dark \| slate-light \| ocean \| nord \| mono` |
| Change gauge bar style | `... config bar-style blocks \| line \| ascii` |
| Show / hide elements | `... config disable git cache` / `... config enable reset capacity` |
| Tune width or thresholds | `... config set barWidth 8 contextWarn 75 quotaDanger 10` |
| Reset to defaults | `... config reset` |
| Preview changes in terminal | `... preview --scenario all --width 100` |
| Run diagnostics | `... doctor` |

## Available Toggle Items

`hint`, `model`, `effort`, `git`, `gitDirty`, `context`, `contextBar`, `capacity`, `cache`, `quota`, `quotaBar`, `quota5h`, `quotaWeekly`, `reset`

## Workflow

1. Run `config show` first if you need to check the current state.
2. Apply the requested change with a single `config` command.
3. Confirm the saved settings concisely; changes take effect on the next statusline refresh without restarting `agy`.

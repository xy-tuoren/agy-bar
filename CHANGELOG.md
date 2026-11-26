# Changelog

All notable changes to **agy-bar** are documented here.

## [0.3.0] - 2026-11-26

### Added
- **Unified health color mode (`colorMode: "health" | "distinct"`)**: Context (`CTX`) and Quota (`5h` / `7d`) gauges now share one cohesive `healthy green -> warning amber -> danger red` color system by default (`distinct` preserves blue/green separation).
- **Smooth 8-level sub-character progress bars (`barStyle: "smooth"`)**: Uses Unicode 1/8 block elements (`▏▎▍▌▋▊▉█`) as the new default gauge style for 48-step visual precision across 6 cells.
- **Workspace directory + Git display (`show.dir`)**: Shows `project (main*)` on line 1 so concurrent terminals across repositories are immediately distinguishable.
- **Actionable `/compact` warning badge (`show.compactHint`)**: Displays `→/compact` next to context usage once the model's danger threshold is reached.
- **Optional live session cost & duration/turns (`show.cost`, `show.session`)**: Displays `~$0.42` and `12m·8t` when enabled.
- **Automatic Vim mode badge (`show.vim`)**: Renders `[NORMAL]` / `[INSERT]` / `[VISUAL]` when `vim.mode` is provided by Antigravity CLI.
- **PII-redacted payload debugger (`agy-bar debug --capture`)**: One-shot sanitized capture of AGY's live `stdin` payload for troubleshooting and issue reports.
- **True-color SVG preview (`assets/preview.svg`)**: Auto-generated directly from `renderStatusline()` for dark and light themes.

## [0.2.0] - 2026-11-26

### Added
- **5-minute Prompt Cache TTL countdown** (`CACHE 88%·3m42s`) with amber (`<= 90s`) and red (`<= 30s` / `exp`) alerts.
- **Live turn output speed (`tok/s`)** and opt-in **context delta (`+12.4K`)** tracking via per-session state files.
- **Local usage & estimated API cost ledger (`agy-bar stats`)** with `today` / `7d` / `30d` / `all` views, cache savings, daily bar chart, and net observed quota delta.
- **Multi-CLI live HUD (`agy-bar monitor`)** for monitoring concurrent `agy` terminals without the desktop app.
- **Per-model context warning thresholds** (`modelThresholds`) and **Gemini 4 Neon** support.
- **`AGENTS.md`** for one-sentence AI-assisted installation.

## [0.1.0] - 2026-11-26

### Added
- Initial zero-dependency Antigravity CLI (`agy`) statusline with `dashboard`, `compact`, and `minimal` presets, 6 themes, Git branch/dirty indicator, responsive narrow-width degradation, safe backup/restore installer, companion `/agy-bar` skill, and cross-platform CI.

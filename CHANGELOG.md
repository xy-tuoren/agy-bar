# Changelog

All notable changes to **agy-bar** are documented here.

## [0.6.0] - 2026-11-26

### Added
- **Full-History Token Activity Dashboard & Terminal Heatmap (`agy-bar stats`)**:
  - Incremental read-only SQLite scanner (`src/history-scan.mjs`) covering both Antigravity CLI (`~/.gemini/antigravity-cli/conversations/*.db`) and Desktop (`~/.gemini/antigravity/conversations/*.db`) history without reading chat text, backed by an `mtime/size` incremental cache (`scan-cache.json`) for sub-20ms repeat runs.
  - **4-Card Overview Strip** in the terminal: `ALL-TIME TOTAL`, `TODAY`, `THIS MONTH`, and `YEAR` (with sessions, active days, daily averages, and current/longest streaks).
  - **True-Color Terminal Activity Heatmap** (`52w` / `32w` / `20w` auto-sized to terminal width) with 4 selectable ramps (`--palette purple|green|cyan|amber`), log-compressed intensity, month labels, and peak day callout.
  - Source filtering (`--source all|cli|desktop|ledger`), CLI vs Desktop split, thinking-token totals, per-model Avg TTFT + speed + estimated API cost & cache savings, and graceful Node 20 fallback to `ledger.jsonl`.

## [0.5.1] - 2026-11-26

### Fixed
- **Re-sync terminal tab title after `agy -c` restart**: Track the hosting `agy` process PID (`lastTabHostPid`) alongside `lastTabTitle` so restarting `agy` (when shell `preexec` resets the tab title) always re-emits the tab title.
- **Emit both OSC 0 & OSC 2**: Ensures both window/surface title and tab title update cleanly across Ghostty, iTerm2, Kitty, WezTerm, and macOS Terminal.

## [0.5.0] - 2026-11-26

### Added
- **Automatic Terminal Tab Title Sync (`src/tab-title.mjs`)**: Automatically updates Ghostty / iTerm2 / Kitty / WezTerm / macOS Terminal tab titles via standard OSC 0 (`\x1b]0;...\x07`) with live status indicators (`●` working / `✓` idle) and `conversation_title` (zero extra tokens, auto-deduped, falls back to workspace/Git dir).
- **Ultra-low-token Agent Tab Summarization (`agy-bar title`)**: Run `agy-bar title "<short topic>"` (or `--clear`) to set a concise custom tab title immediately from the Agent's existing context (~10 tokens, zero extra API calls). Automatically resets if the user renames the chat via `/rename`.
- **Configurable tab title options**: `tabTitle` (`on|off`), `tabTitleSource` (`auto|title|dir|title+dir`), and `tabTitleMaxLen` (`10..60`).

## [0.4.0] - 2026-11-26

### Added
- **Time-To-First-Token (`TTFT`) display (`show.ttft`)**: Displays exact first-token latency alongside decode speed (`TTFT 1.9s·158t/s`), with configurable `ttftWarnSec` (default `8s`) and `ttftDangerSec` (default `15s`) color thresholds.
- **Exact streaming decode speed & cache completion time (`src/step-timing.mjs`)**: On Node `>= 22.13`, reads only numeric step timing metadata from the local AGY conversation SQLite database in `readOnly: true` mode (never reads prompts or replies; opt-out via `config set dbTiming off`), cleanly separating TTFT wait time from pure streaming `tok/s` and restoring accurate 5-min cache countdowns even after `agy -c` restarts. Gracefully falls back to pure `stdin` timing on Node 20.
- **`Avg TTFT` in `agy-bar stats` & live `TTFT` column in `agy-bar monitor`**.

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

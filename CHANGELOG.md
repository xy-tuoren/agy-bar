# Changelog

All notable changes to **agy-bar** are documented here.

## [0.7.3] - 2026-11-26

### Added
- **Crisp Segmented Gauge Styles (`segments`, `squares`, `pills`, `dots`)**:
  - Added 4 distinct cell-separated progress bar styles that render with clean gaps between every cell even in GPU terminals like Ghostty (where full-block `█`/`░` glyphs merge seamlessly):
    - `segments` (`▮▮▮▮▯▯`, new default — bright filled `▮` + muted track `▮` in color, `▯` in plain/mono)
    - `squares` (`■■■■□□`, matches `agy-bar stats` heatmap squares)
    - `pills` (`▰▰▰▰▱▱`, slanted capsules)
    - `dots` (`●●●●○○`, circular dots)
  - Existing `smooth`, `blocks`, `line`, and `ascii` styles remain available via `agy-bar config bar-style <style>`.

## [0.7.2] - 2026-11-26

### Changed
- **Transparent opt-in prompt for the `~/.zshrc` shell hook**:
  - Interactive `agy-bar install` now clearly explains the optional 7-line managed `agy()` shell hook (what file it touches, that `agy` binaries are never modified, and how to remove it via `agy-bar proxy unhook`) and asks `[y/N]` before touching `~/.zshrc` / `~/.bashrc` / `config.fish`.
  - Non-interactive installs (scripts, CI, `-y`) default to leaving shell rc files completely untouched unless `--proxy-hook` is explicitly passed (while seamlessly preserving an already-installed managed hook across upgrades).
  - Updated `AGENTS.md` so AI installers ask the user before enabling `--proxy-hook`.

## [0.7.1] - 2026-11-26

### Added
- **Seamless Shell Hook for Plain `agy` (`src/shell-hook.mjs`, `agy-bar proxy hook` / `unhook`)**:
  - `agy-bar install` now adds a clean, reversible managed `agy()` function block (`# >>> agy-bar proxy >>> ... # <<< agy-bar proxy <<<`) to `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` / PowerShell `$PROFILE` (opt out via `--no-shell-hook`, remove anytime via `agy-bar proxy unhook` or `agy-bar uninstall`).
  - Once loaded (open a new terminal or `source ~/.zshrc`), simply typing **`agy`** (including `agy -c`, `agy --dangerously-skip-permissions`, `agy update`) automatically routes through your local Clash/Surge/v2ray proxy without enabling TUN mode — and stays completely silent with zero noise if no local proxy is running.
  - Passes `--from-hook -- "$@"` to avoid any flag collision with `agy`, falls back gracefully to `command agy` if `agy-bar` is removed, and supports one-shot direct bypass via `command agy ...` or `AGY_BAR_NO_PROXY=1 agy ...`.

## [0.7.0] - 2026-11-26

### Added
- **No-TUN Proxy Launcher (`agy-bar run` & `agy-bar proxy`)**:
  - Launch `agy` directly through your local Clash / Clash Verge / Surge / v2ray proxy **without enabling TUN mode** (`agy-bar run [agy args...]`), injecting standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (uppercase + lowercase) and loopback-safe `NO_PROXY` environment variables into the spawned `agy` process.
  - **Zero-config auto-detection (`mode: auto`)**: Automatically detects macOS system proxy (`scutil --proxy`), Windows system proxy (`HKCU\...\Internet Settings`), or live localhost proxy ports (`7897`, `7890`, `6152`, `10809`, `1087`, `20171`, `20172`, `10808`, `1080`) even when both TUN and System Proxy are turned off.
  - **Proxy management CLI (`agy-bar proxy`)**: `status`/`check` (live TCP reachability + latency), `auto`, `set <url>`, `on`/`off`, `mode <auto|manual|off>`, `bypass <list|reset>`, `env [--sh|--fish|--pwsh]`, and `clear`, with automatic credential redaction (`user:pass@` → `***@`) and Go/gRPC HTTP CONNECT guidance.
  - **Interactive TUI signal safety & `--no-proxy` / `--proxy <url>` overrides**: Forwards all `agy` flags verbatim (including `-c`, `--dangerously-skip-permissions`, `--help`), prints launch notices on `stderr` so piped `stdout` stays clean, and guards against recursive wrappers.
- **Global `~/.local/bin/agy-bar` CLI Shim**: Automatically installed alongside `agy` during `agy-bar install` (with unrelated-file collision protection and clean removal on `uninstall`) so `agy-bar run`, `agy-bar proxy`, `agy-bar stats`, `agy-bar monitor`, and `agy-bar title` work directly from any terminal.

## [0.6.2] - 2026-11-26

### Added
- **Weekly (`WK`) & Monthly (`MO`) Token Totals in Bottom Statusbar (`show.weekTokens`, `show.monthTokens`)**: Extends line 1's minimal token strip to `DAY · WK · MO · ALL`, color-matched to `agy-bar stats`, with graceful progressive shedding (`DAY·WK·MO·ALL` → `DAY·WK·ALL` → `DAY·ALL` → `DAY` → hidden) on narrower terminals.

## [0.6.1] - 2026-11-26

### Added
- **Minimal Always-On Token Summary in Bottom Statusbar (`show.todayTokens`, `show.totalTokens`)**: Displays `DAY 133.6M · ALL 903.9M` right beside the model name on line 1 (with automatic narrow-width degradation: `DAY + ALL` → `DAY` → hidden), backed by a `< 1ms` cached `usage-summary.json` snapshot that increments live on every turn and auto-syncs every 5 minutes without slowing down the statusline.

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

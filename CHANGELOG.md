# Changelog

All notable changes to **agy-bar** are documented here.

## [1.0.0] - 2026-11-27

First stable release of **agy-bar** — zero-dependency statusline HUD, native AGY window/tab title hook, no-TUN local proxy launcher, 52-week token heatmap, live 3-tier pricing cache, and multi-CLI monitor for Antigravity CLI (`agy`).

### Added & Improved
- **Multi-Tab Custom Title Targeting (`bin/agy-bar.mjs`, `src/telemetry.mjs`, `src/title.mjs`)**:
  - `agy-bar title` now matches the invoking terminal's host `agy` PID (across both `lastTabHostPid` and native `.title` markers) before falling back to most-recent session, preventing accidental cross-tab renames when multiple `agy` sessions run concurrently.
  - `agy-bar title` inspection output now reports `nativeTitleActive` and always displays the live computed `activeTabTitle`.
- **CI Native Title Smoke Verification (`.github/workflows/ci.yml`)**:
  - Added cross-platform `src/title.mjs` smoke verification to the 9-job macOS / Linux / Windows × Node 20 / 22 / 24 CI matrix.
- **v1.0.0 Documentation & Showcase Polish (`README.md`, `README.zh-CN.md`, `AGENTS.md`, `skills/agy-bar/SKILL.md`, `assets/monitor-preview.svg`)**:
  - Updated `monitor-preview.svg` to showcase live multi-state tracking (`working`, `sub:3`, `? confirm`, `idle`).
  - Aligned Windows native title documentation, test counts (`87` tests), `npx -y agy-bar@latest install` guidance, Ghostty title tips, and npm Provenance badge across English & Chinese READMEs.

## [0.9.5] - 2026-11-26

### Added
- **Automated Tokenless npm OIDC Trusted Publishing & Provenance (`.github/workflows/publish.yml`)**:
  - Releases are now built, tested, and published automatically from GitHub Actions via short-lived OIDC Trusted Publishing with cryptographic Sigstore provenance attestations (`npm publish --provenance --access public`) and release-tag/package-version verification.

## [0.9.4] - 2026-11-26

### Changed
- **Tab Title Prefix for Background Tasks (`src/agent-state.mjs`)**:
  - Reserved the active dot (`●` / `● [N]`) strictly for an active main agent or running subagents. When the agent finishes (`agent_state: "idle"`, `subagents` idle) while only background apps/tasks (`task_count > 0`, e.g., a dev server or daemon) remain alive, the terminal tab title now cleanly shows `✓ <topic>` instead of `●`, while statusline Line 1 (`TASK N`) and `agy-bar monitor` (`task:N`) continue surfacing active background tasks.

## [0.9.3] - 2026-11-26

### Added
- **Official Native Antigravity CLI `title` Hook (`src/title.mjs`, `src/installer.mjs`)**:
  - Upgraded terminal tab/window title sync to Antigravity CLI's official `settings.json` `"title"` command interface (`https://antigravity.google/docs/cli/title`) so `agy` itself drives window/tab titles cleanly on **macOS, Linux, and native Windows Terminal** with zero `/dev/tty` escape-sequence interleaving and zero `ps` subprocesses.
  - `agy-bar install` automatically configures `settings.title` (backing up previous settings for clean `uninstall` restoration, refusing to overwrite unrelated custom `title` commands, and supporting `--no-title` opt-out); `agy-bar doctor` now verifies native title health.
  - Uses a lightweight per-session `.title` marker so `statusline.mjs` automatically steps aside once native `title` is active while seamlessly keeping hardened `/dev/tty` fallback for un-restarted sessions.

### Fixed
- **Hardened Fallback Tab Title Sync (`src/tab-title.mjs`, `src/statusline.mjs`, `src/telemetry.mjs`)**:
  - Ran fallback tab-title sync synchronously before async SQLite scans to prevent out-of-order `working`/`idle` races, cached `lastTabTty` for zero-`ps` direct writes with `O_NOCTTY`, widened `ps` timeout to `500ms`, and stopped persisting `lastTabTitle` on failed writes so retries happen automatically.
- **Account Isolation Key (`src/quota-sync.mjs`)**:
  - Included AGY's live top-level `payload.email` field when computing the non-PII SHA-1 account key for local cross-terminal quota sync.

## [0.9.2] - 2026-11-26

### Added
- **Cross-Terminal Local Quota Freshness Sync (`src/quota-sync.mjs`)**:
  - Shares observed account quota snapshots locally across concurrent `agy` terminals via atomic `~/.gemini/config/agy-bar/quota-cache.json` (zero network requests, zero extra disk writes when idle, hashed non-PII account isolation).
  - Whenever **any** `agy` terminal triggers a new 5h/7d reset window (newer `reset_time`) or consumes quota in the same window (strictly lower `remaining_fraction`), all other idle terminals and `agy-bar monitor` automatically display the freshest quota on their very next refresh instead of staying stuck on stale `0% (due)` or outdated percentages.
- **Clearer Expired-Reset `(ready)` Indicator (`src/render.mjs`, `src/monitor.mjs`)**:
  - When a `5h` bucket's `reset_time` has already passed (`reset_time <= now`) and the sibling `7d` weekly cap still has remaining quota, replaces alarming bold-red `0% (due)` with calm amber `0%` + green `(ready)` so you can tell at a glance that the reset point has passed and sending a message will refresh it.
  - Keeps bold-red `0% (due)` when the sibling `7d` weekly bucket is also exhausted (`0%` and not yet due).

### Fixed
- **Epoch-Zero Reset Sentinel (`1970-01-01T00:00:00Z`)**: Stopped rendering misleading `(due)` on unused 100% buckets whose protobuf zero timestamp (`1970-01-01T00:00:00Z`) indicates the window has not started yet.

## [0.9.1] - 2026-11-26

### Added
- **Full 6-State Agent Activity Machine (`src/agent-state.mjs`)**:
  - Unified session activity classification across terminal tab titles, statusline Line 1 badges, telemetry turn timers, and `agy-bar monitor`, aligned with Antigravity CLI's official `statusLine` payload schema (`agent_state`, `tool_confirmation_pending`, `subagents`, `task_count`, and native `cost.total_usd`).
  - **Subagents / Background Tasks Active (`SUB N` / `TASK N` / `● [N]`)**: Replaced emoji `⚡N` with cohesive ASCII `SUB N` and `TASK N` badges on Line 1 (zero cross-terminal glyph-width drift). When the parent agent pauses (`agent_state: "idle"`) while subagents (`subagents[].status === "running"`) or background tasks (`task_count > 0`) are still executing, tab titles stay active (`● [N] <topic>` / `● <topic>`) instead of falsely showing `✓` complete.
  - **Waiting for User Input / Approval (`?` / `CONFIRM` / `INPUT`)**: Displays `? <topic>` on the tab, bold amber `CONFIRM` (`tool_confirmation_pending: true`) or `INPUT` (`agent_state: "reviewing"`) on statusline Line 1, and `? confirm` / `? input` + `N waiting` summary in `agy-bar monitor`.
  - **Error & Startup States (`✗ ERR` / `…`)**: Distinctly marks `error` (`✗` + bold red `ERR`) and `authenticating` / `initializing` (`…`) instead of falling back to `✓`.
  - **Native `cost.total_usd` Compatibility**: Automatically incorporates AGY's native `cost.total_usd` field when reported alongside local DB/telemetry cost tracking.

## [0.9.0] - 2026-11-26

### Added
- **Live Dynamic Pricing Cache & 24h Background SWR Sync (`src/pricing.mjs`, `src/pricing-sync.mjs`, `agy-bar pricing`)**:
  - Calibrated built-in fallback rates to real public API pricing for **Gemini 4 Neon** (`$3/$15/$0.15`), **Carbon / Argon** (`$2/$10/$0.10`), **Hydrogen** (`$1.5/$7.5/$0.075`), **Gemini 3.8 Flash** (`$0.75/$3.75`), and **Claude Opus 4.5–4.8** (`$5/$25/$0.50`), **Sonnet** (`$3/$15`), **Haiku 4.5** (`$1/$5`).
  - Added 3-tier `< 0.1ms` local pricing lookup (`config.customPricing` → synced `~/.gemini/config/agy-bar/pricing-cache.json` → built-in calibrated rates), memoized by file `mtimeMs`.
  - Added zero-dependency proxy-aware HTTPS sync (`models.dev/api.json` primary with automatic `LiteLLM` fallback, `gzip`, `ETag` `304`, sanity bounds, and atomic writes; works without TUN via local HTTP CONNECT proxy).
  - Enabled non-blocking 24h background Stale-While-Revalidate (`pricingAutoSync: true`, single-flight 6h failure backoff; opt out anytime via `agy-bar config set pricingAutoSync off`).
  - Added `agy-bar pricing show | sync | set | reset` CLI commands.
- **Subagent Cost Rollup & Complete Uninstall Env Cleanup (`src/history-scan.mjs`, `src/proxy.mjs`, `src/installer.mjs`)**:
  - Rolls up spawned subagent (and nested descendant) token spend into the parent conversation's live `~$...` cost via read-only `conversation_summaries.db` parent ID links (zero chat text read, zero double-counting of daily totals), automatically tightening usage summary refresh to `20s` while subagents are running (`⚡N`).
  - Made `agy-bar uninstall` clean orphan shell hooks/shims even when backup metadata is absent, print exact shell-specific unset commands for the active terminal, and support `eval "$(agy-bar uninstall --remove-skill --purge --print-cleanup)"` for one-shot disk + live-shell env cleanup.
- **Compact `~` Workspace Paths & Live Git Diff Line Counts (`dirStyle`, `show.gitDiff`)**:
  - Top-left workspace display now defaults to a clean home-abbreviated path (`~/code`, `~/code/agy-bar`, or `~/…/client/agy-bar` for deep directories), automatically falling back to folder name on narrow split panes.
  - Displays live green/red workspace diff stats (`+142 -38`) right beside the Git branch (covering tracked staged/unstaged changes via `git diff --numstat HEAD` plus new untracked non-binary text files, sharing the 3s session cache and hidden automatically when clean).
- **Automatic Cross-Terminal 256-Color & Light-Theme Adaptation (`src/ansi.mjs`, `src/stats.mjs`, `src/monitor.mjs`)**:
  - Automatically downscales 24-bit RGB colors to nearest xterm-256 palette (`\x1b[38;5;Nm`) in macOS `Terminal.app` (`Apple_Terminal`) and `tmux` / `screen` / SSH terminals without `COLORTERM=truecolor`, and honors `NO_COLOR` and `TERM=dumb`.
  - Added dedicated light-mode heatmap palettes when using `slate-light`, and shrunk `agy-bar stats` card grid width to `77` cols so it fits cleanly inside standard 80-column terminals without wrapping.

### Improved
- **Cleaner Two-Line Information Architecture & Calmer Palette (`src/render.mjs`)**:
  - **Line 1 (Identity + Cumulative Overview)**: Removed idle `? for shortcuts` clutter so compact workspace path, Git branch, and `PX 7897` lead cleanly; busy state lights up a compact `● 30s · esc` indicator. Merged daily tokens and daily cost into one cohesive `DAY 136M/$13.2 · WK 810M · MO 875M · ALL 906M` strip with a calm neutral palette so green/amber/red stay reserved for live health signals.
  - **Line 2 (Live Session Left, Account Quotas Right)**: Placed the current conversation's estimated spend (`~$0.18`) alongside `CTX`, `CACHE`, and `TTFT·t/s` on the left, keeping the right side dedicated exclusively to steady `5h` / `7d` quota gauges even on 116-column split panes.
- **Zero-Subprocess Statusline Hot Path & Atomic Writes (`src/fs-atomic.mjs`, `tab-title.mjs`, `git.mjs`, `step-timing.mjs`, `themes.mjs`)**:
  - Added `process.ppid === prevTabHostPid` fast path in `syncTabTitle`, 3-second `git status` cache, SQLite `.db`/`.db-wal` `mtime` stamp skip, 5-minute Windows Registry theme cache, and temp-file + `renameSync` atomic writes across all state files.
  - Deduplicated protobuf decoder across `step-timing.mjs` and `history-scan.mjs`.
- **`agy-bar monitor` Polish & Visual Showcase**: Fixed CJK column width alignment, aligned context bar colors with `config.colorMode`, replaced raw quota keys with friendly labels (`5h`, `7d`, `Claude 5h`), added a live `Cost` column, and added `assets/stats-preview.svg`.

### Fixed
- **Self-Reinstall Guard (`src/installer.mjs`)**: Prevented `agy-bar install` invoked from the installed global shim from wiping its own runtime directory; bundled `skills/agy-bar/SKILL.md` inside `app/`.
- **Windows Compatibility Hardening (`src/installer.mjs`, `src/proxy.mjs`, `src/shell-hook.mjs`, `src/render.mjs`, `src/telemetry.mjs`)**:
  - Fixed `agy-bar doctor` recognizing Windows Base64-encoded `statusLine.command`.
  - Fixed `agy-bar run` launching `.cmd`/`.bat` `agy` shims on Windows via `PATHEXT` resolution and added `windowsHide: true` to `reg` calls.
  - Fixed PowerShell shell hook quoting `'--'` so PowerShell doesn't strip the argument separator, and added Windows PowerShell 5.1 profile detection/cleanup.
  - Fixed case-insensitive Windows home path shortening/redaction, Windows `PATH` comparison, and BMP emoji (`⚡`) 2-column display width calculation.

## [0.8.2] - 2026-11-26

### Added
- **Live Conversation & Daily Estimated Cost Strip (`show.cost`, `show.todayCost`)**:
  - Displays **`CHAT ~$1.24 · DAY $13.18`** on line 2 immediately to the left of the `5h` quota gauge (enabled by default in `dashboard`, gracefully compacting to `~$1.24 · DAY $13.18` → `~$1.24` → hidden on narrower terminals).
  - Powered by `< 1ms` cached `usage-summary.json` (`todayCostUsd` + `recentSessionCosts` for resumed `agy -c` conversations) with live per-turn increments (`turnCostDeltaUsd`) so resumed multi-turn chats reflect their full conversation spend.

## [0.8.1] - 2026-11-26

### Changed
- **Refined Active Proxy Badge (`PX 7897` / `PX on`)**: Updated line 1's active proxy micro-badge from `↗7897` to `PX 7897` (muted `PX` + healthy green port) so it matches the minimalist `DAY` / `WK` / `MO` / `CTX` typography consistently.

## [0.8.0] - 2026-11-26

### Added
- **Active Proxy Micro-Badge (`show.proxy`, e.g. `↗7897`)**: Reads `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` directly from process memory (`0ms`, zero network, credentials never exposed) and shows a compact green-arrow port badge (`↗7897`) on line 1 whenever a session is running through a proxy — hidden automatically when running direct.
- **Zero-Clutter On-Demand Work-State Badges (hidden when idle)**:
  - **Live Turn Elapsed Timer (`show.turnTimer`)**: Shows elapsed time right next to `esc to cancel` while the agent is busy (`24s`, `1m15s`), shifting amber at `>= 30s` and bold red at `>= 90s`.
  - **Running Subagents Counter (`show.subagents`)**: Displays `⚡N` on line 1 whenever background subagents are actively running (`payload.subagents`).
  - **Special Execution Mode Badges (`show.mode`)**: Lights up `PLAN` (amber) or `SANDBOX` (purple) on line 1 only when active so you never lose track of non-default modes.

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

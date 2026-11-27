# AGENTS.md — AI-Assisted Installation Guide for `agy-bar`

If a user asks you to install **agy-bar** into their Antigravity CLI (`agy`), follow these exact steps:

1. **Verify prerequisites**
   - Run `node -v` and confirm Node.js is **20.0.0 or newer**.
   - If Node.js is missing or older than 20, stop and inform the user; do **not** install or upgrade Node.js automatically.

2. **Choose installation method**
   - **Recommended (via npm, zero clone):** run `npx -y agy-bar@latest install --yes` (or `npx -y agy-bar@latest install --proxy-hook` if the user wants the shell hook below) and verify with `agy-bar doctor`.
   - **Or from GitHub `main`:**
     - If you are already inside a clean `agy-bar` clone on `main` pointing to `xy-tuoren/agy-bar` with an empty `git status --porcelain`, run `git pull --ff-only origin main`.
     - Otherwise clone fresh into a clean directory (e.g. `~/agy-bar` on macOS/Linux/WSL or `%USERPROFILE%\agy-bar` on Windows):
       ```sh
       git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
       ```

3. **Ask about the optional no-TUN proxy shell hook, then run the installer & self-check**
   - Before running `install`, briefly ask the user whether they also want `agy-bar` to add a 7-line managed `agy()` function to their shell rc (`~/.zshrc` / `~/.bashrc` / `config.fish`) so typing plain `agy` automatically uses their local proxy (Clash/Surge/v2ray) without TUN mode (removable anytime via `agy-bar proxy unhook` or `uninstall`).
   - If the user says **yes**, pass `--proxy-hook`; if **no** (or unsure), pass `--yes` (omitting `--proxy-hook`) so their shell rc stays completely untouched (they can still use `agy-bar run` anytime).
   ```sh
   npx -y agy-bar@latest install --yes           # or: npx -y agy-bar@latest install --proxy-hook
   agy-bar doctor
   ```
   - Zero third-party dependencies: do **not** run `npm install`.
   - Non-interactive `install` leaves `~/.zshrc` untouched by default unless `--proxy-hook` is passed (or an existing managed hook is already present).
   - Installs the statusline runtime, official native AGY `title` hook (preserving any existing custom `settings.json.title`; pass `--no-title` to opt out), global `~/.local/bin/agy-bar` command, and companion `/agy-bar` skill by default. Pass `--no-skill` only if the user explicitly opts out or if an unrelated `agy-bar` skill already exists (never overwrite unrelated skills).

4. **Strict safety boundaries**
   - Never modify `agy-bar` source files, Antigravity binaries, or unrelated fields in `~/.gemini/antigravity-cli/settings.json`.
   - Never kill or restart the user's running `agy` process.
   - After confirming `doctor` passes, inform the user in their language to **restart `agy`** (and optionally run `/skills reload` in existing sessions to load `/agy-bar`).

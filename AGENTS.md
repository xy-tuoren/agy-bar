# AGENTS.md — AI-Assisted Installation Guide for `agy-bar`

If a user asks you to install **agy-bar** into their Antigravity CLI (`agy`), follow these exact steps:

1. **Verify prerequisites**
   - Run `node -v` and confirm Node.js is **20.0.0 or newer**.
   - If Node.js is missing or older than 20, stop and inform the user; do **not** install or upgrade Node.js automatically.

2. **Obtain the latest `main` code cleanly**
   - If you are already inside a clean `agy-bar` clone on `main` pointing to `xy-tuoren/agy-bar` with an empty `git status --porcelain`, run `git pull --ff-only origin main`.
   - Otherwise clone fresh into a clean directory (e.g. `~/agy-bar` on macOS/Linux/WSL or `%USERPROFILE%\agy-bar` on Windows):
     ```sh
     git clone https://github.com/xy-tuoren/agy-bar.git ~/agy-bar
     ```

3. **Run the non-interactive installer & self-check**
   ```sh
   cd ~/agy-bar
   node bin/agy-bar.mjs install
   node bin/agy-bar.mjs doctor
   ```
   - Zero third-party dependencies: do **not** run `npm install`.
   - Installs the statusline runtime and the companion `/agy-bar` skill by default. Pass `--no-skill` only if the user explicitly opts out or if an unrelated `agy-bar` skill already exists (never overwrite unrelated skills).

4. **Strict safety boundaries**
   - Never modify `agy-bar` source files, Antigravity binaries, or unrelated fields in `~/.gemini/antigravity-cli/settings.json`.
   - Never kill or restart the user's running `agy` process.
   - After confirming `doctor` passes, inform the user in their language to **restart `agy`** (and optionally run `/skills reload` in existing sessions to load `/agy-bar`).

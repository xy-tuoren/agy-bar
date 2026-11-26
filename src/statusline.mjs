import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { readGitInfo } from './git.mjs';
import { renderFallback, renderStatusline } from './render.mjs';

export async function runStatusline({ stdin = process.stdin, stdout = process.stdout, env = process.env, argv = process.argv } = {}) {
  let raw = '';
  for await (const chunk of stdin) {
    raw += chunk;
  }

  const config = loadConfig();
  const color = !('NO_COLOR' in env) && !argv.includes('--plain') && config.theme !== 'mono';

  try {
    const payload = JSON.parse(raw);
    const cwd = payload?.workspace?.current_dir || payload?.cwd || null;
    const git = config.show.git && cwd ? readGitInfo(cwd, { checkDirty: config.show.gitDirty }) : null;
    const rendered = renderStatusline(payload, { config, color, git, themeOptions: { env } });
    stdout.write(`${rendered}\n`);
  } catch {
    const fallback = renderFallback(config, { color });
    stdout.write(`${fallback}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runStatusline();
}

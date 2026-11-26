import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_MARKER = '<!-- agy-bar: managed skill -->';
const SOURCE_SKILL = fileURLToPath(new URL('../skills/agy-bar/SKILL.md', import.meta.url));

export function targetSkillPath(home = homedir()) {
  return join(home, '.gemini', 'skills', 'agy-bar', 'SKILL.md');
}

export function checkSkillConflict(home = homedir()) {
  const dest = targetSkillPath(home);
  if (existsSync(dest)) {
    const existing = readFileSync(dest, 'utf8');
    if (!existing.includes(SKILL_MARKER)) {
      throw new Error(
        `Existing unrelated agy-bar skill found at ${dest}; refusing to overwrite. Re-run with --no-skill or move the existing skill first.`,
      );
    }
  }
}

export function installSkill({ home = homedir(), sourcePath = SOURCE_SKILL } = {}) {
  checkSkillConflict(home);
  const dest = targetSkillPath(home);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(sourcePath, 'utf8'), 'utf8');
  return dest;
}

export function uninstallSkill({ home = homedir() } = {}) {
  const dest = targetSkillPath(home);
  if (!existsSync(dest)) return { removed: false, reason: 'not-found' };
  const content = readFileSync(dest, 'utf8');
  if (!content.includes(SKILL_MARKER)) {
    return { removed: false, reason: 'unmanaged' };
  }
  rmSync(dirname(dest), { recursive: true, force: true });
  return { removed: true, path: dest };
}

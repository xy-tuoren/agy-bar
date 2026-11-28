import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sanitizeText } from './ansi.mjs';
import { configDir } from './config.mjs';
import { writeFileAtomic } from './fs-atomic.mjs';
import { listSessions } from './telemetry.mjs';

const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_DIGEST_CHARS = 3600;
const MAX_TURN_SNIPPET_CHARS = 520;
const MAX_ARTIFACTS_TOTAL_CHARS = 2200;
const MAX_SINGLE_ARTIFACT_CHARS = 780;

const ARTIFACT_PRIORITY = Object.freeze([
  'task.md',
  'todo.md',
  'checklist.md',
  'implementation_plan.md',
  'plan.md',
  'walkthrough.md',
]);

function normalizePathForCompare(p, platform = process.platform) {
  const raw = String(p ?? '').trim();
  if (!raw) return '';
  const resolved = resolve(raw).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function redactInlineSecrets(text) {
  return String(text ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '***@***')
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[JWT_REDACTED]');
}

export function agyCacheLastConversationsPath(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
}

export function agyBrainDir(conversationId, home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli', 'brain', conversationId);
}

export function agyBrainTranscriptPath(conversationId, home = homedir()) {
  return join(agyBrainDir(conversationId, home), '.system_generated', 'logs', 'transcript.jsonl');
}

export function extractBrainArtifactsSummary(
  conversationId,
  { home = homedir(), maxFiles = 3, maxChars = MAX_ARTIFACTS_TOTAL_CHARS } = {},
) {
  if (!conversationId) return [];
  const dir = agyBrainDir(conversationId, home);
  if (!existsSync(dir)) return [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const mdFiles = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.') || !ent.name.toLowerCase().endsWith('.md')) continue;
    const fullPath = join(dir, ent.name);
    try {
      const st = statSync(fullPath);
      if (st.size <= 0) continue;
      const lower = ent.name.toLowerCase();
      const prioIdx = ARTIFACT_PRIORITY.indexOf(lower);
      mdFiles.push({
        name: ent.name,
        path: fullPath,
        priority: prioIdx >= 0 ? prioIdx : ARTIFACT_PRIORITY.length,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // Ignore unreadable artifacts.
    }
  }

  if (mdFiles.length === 0) return [];
  mdFiles.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : b.mtimeMs - a.mtimeMs));

  const out = [];
  let remaining = maxChars;
  for (const file of mdFiles.slice(0, maxFiles)) {
    if (remaining < 120) break;
    try {
      const raw = readFileSync(file.path, 'utf8');
      const cleaned = redactInlineSecrets(raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
      if (!cleaned) continue;
      const budget = Math.min(MAX_SINGLE_ARTIFACT_CHARS, remaining);
      const excerpt = cleaned.length > budget ? `${cleaned.slice(0, budget - 1).trimEnd()}…` : cleaned;
      out.push({
        name: file.name,
        path: file.path,
        excerpt,
        truncated: cleaned.length > budget,
      });
      remaining -= excerpt.length + 60;
    } catch {
      // Skip unreadable file.
    }
  }
  return out;
}

export function latestHandoffFilePath(baseDir = configDir(homedir())) {
  return join(baseDir, 'handoffs', 'latest.md');
}

export function findLatestConversationForCwd(
  cwd = process.cwd(),
  { home = homedir(), baseDir = configDir(homedir()), platform = process.platform } = {},
) {
  const normCwd = normalizePathForCompare(cwd, platform);
  const sessions = listSessions({ baseDir });

  // Check agy-bar's own active session telemetry first for matching cwd (gives title + exact ID).
  const matchingSessions = sessions.filter((s) => s?.cwd && normalizePathForCompare(s.cwd, platform) === normCwd);
  const telemetryMatch = matchingSessions[0] || null;

  // Check AGY's cache/last_conversations.json as authoritative fallback/primary source.
  const cachePath = agyCacheLastConversationsPath(home);
  let cacheId = null;
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Shape A: { "/path/to/repo": "conv-id" | { conversation_id, id } }
        for (const [key, val] of Object.entries(parsed)) {
          if (normalizePathForCompare(key, platform) === normCwd) {
            if (typeof val === 'string' && val.trim()) cacheId = val.trim();
            else if (val && typeof val === 'object') {
              cacheId = String(val.conversation_id || val.conversationId || val.id || '').trim() || null;
            }
            if (cacheId) break;
          }
        }
        // Shape B: { conversations: [...] } or { entries: [...] }
        const list = Array.isArray(parsed.conversations)
          ? parsed.conversations
          : Array.isArray(parsed.entries)
            ? parsed.entries
            : null;
        if (!cacheId && list) {
          for (const item of list) {
            const itemCwd = item?.cwd || item?.workspace || item?.dir || '';
            if (itemCwd && normalizePathForCompare(itemCwd, platform) === normCwd) {
              cacheId = String(item.conversation_id || item.conversationId || item.id || '').trim() || null;
              if (cacheId) break;
            }
          }
        }
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const itemCwd = item?.cwd || item?.workspace || item?.dir || '';
          if (itemCwd && normalizePathForCompare(itemCwd, platform) === normCwd) {
            cacheId = String(item.conversation_id || item.conversationId || item.id || '').trim() || null;
            if (cacheId) break;
          }
        }
      }
    } catch {
      // Ignore malformed cache file.
    }
  }

  const telemetryId = telemetryMatch?.sessionId && !telemetryMatch.sessionId.startsWith('local-') ? telemetryMatch.sessionId : null;
  const conversationId = cacheId || telemetryId || null;

  return {
    conversationId,
    title: telemetryMatch?.customTitle || telemetryMatch?.conversationTitle || null,
    branch: telemetryMatch?.branch || null,
    source: cacheId ? 'agy-cache' : telemetryId ? 'agy-bar-session' : 'none',
  };
}

function extractTextFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const msg = entry.message && typeof entry.message === 'object' ? entry.message : entry;
  const rawRole = String(msg.role || entry.role || entry.type || entry.author || '').toLowerCase();
  let role = null;
  if (rawRole.includes('user') || rawRole === 'human') role = 'User';
  else if (rawRole.includes('assistant') || rawRole.includes('model') || rawRole === 'agent') role = 'Assistant';
  else return null;

  let text = '';
  const content = msg.content ?? msg.text ?? msg.parts ?? entry.text ?? entry.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') {
        if (!block.type || block.type === 'text' || block.type === 'output_text' || block.type === 'input_text') {
          parts.push(block.text);
        }
      }
    }
    text = parts.join(' ');
  }

  const cleaned = redactInlineSecrets(sanitizeText(text).replace(/\s+/g, ' ').trim());
  if (!cleaned) return null;
  return {
    role,
    text: cleaned.length > MAX_TURN_SNIPPET_CHARS ? `${cleaned.slice(0, MAX_TURN_SNIPPET_CHARS - 1)}…` : cleaned,
  };
}

export function extractTranscriptDigest(
  conversationId,
  { home = homedir(), maxTailBytes = MAX_TRANSCRIPT_TAIL_BYTES, maxTurns = 8, maxChars = MAX_DIGEST_CHARS } = {},
) {
  if (!conversationId) return null;
  const transcriptPath = agyBrainTranscriptPath(conversationId, home);
  if (!existsSync(transcriptPath)) return null;

  let tailText = '';
  try {
    const st = statSync(transcriptPath);
    if (st.size <= 0) return null;
    const start = Math.max(0, st.size - maxTailBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    tailText = buf.toString('utf8');
    if (start > 0) {
      const firstNl = tailText.indexOf('\n');
      tailText = firstNl >= 0 ? tailText.slice(firstNl + 1) : '';
    }
  } catch {
    return null;
  }

  const turns = [];
  for (const line of tailText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const item = extractTextFromEntry(parsed);
      if (item) turns.push(item);
    } catch {
      // Skip malformed/truncated lines.
    }
  }

  if (turns.length === 0) return null;

  // Keep the earliest user goal if we have many turns + the most recent turns.
  const selected = [];
  if (turns.length > maxTurns) {
    const firstUser = turns.find((t) => t.role === 'User');
    if (firstUser) selected.push(firstUser);
    for (const t of turns.slice(-(maxTurns - selected.length))) {
      if (t !== firstUser) selected.push(t);
    }
  } else {
    selected.push(...turns);
  }

  const lines = [];
  let totalChars = 0;
  for (const t of selected) {
    const bullet = `- **${t.role}**: ${t.text}`;
    if (totalChars + bullet.length > maxChars && lines.length > 0) break;
    lines.push(bullet);
    totalChars += bullet.length + 1;
  }
  return lines.join('\n');
}

export function collectGitHandoffSnapshot(cwd = process.cwd(), { execFile = execFileSync } = {}) {
  const runGit = (args, { preserveLeading = false } = {}) => {
    try {
      const out = execFile('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return preserveLeading ? out.replace(/[\r\n]+$/, '') : out.trim();
    } catch {
      return '';
    }
  };

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return null;
  const statusLines = runGit(['status', '--short'], { preserveLeading: true })
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 20);
  const diffStat = runGit(['diff', '--stat']).split(/\r?\n/).filter(Boolean).slice(0, 15);
  const recentCommits = runGit(['log', '-n', '3', '--oneline']).split(/\r?\n/).filter(Boolean).slice(0, 3);
  const changedFiles = statusLines
    .map((line) => line.replace(/^[ MARCUD?!]{1,2}\s+/, '').trim().replace(/^.* -> /, ''))
    .filter(Boolean)
    .slice(0, 15);

  return {
    branch,
    status: statusLines.join('\n'),
    diffStat: diffStat.join('\n'),
    recentCommits,
    changedFiles,
  };
}

export function buildHandoffPrompt({
  cwd = process.cwd(),
  conversationId = null,
  title = null,
  transcriptDigest = null,
  artifacts = [],
  gitSnapshot = null,
  fromAlias = null,
  targetAlias = null,
} = {}) {
  const projectName = basename(cwd) || cwd;
  const sections = [
    `Continue the ongoing task in workspace \`${projectName}\` after a seamless multi-account switch${fromAlias && targetAlias ? ` (${fromAlias} -> ${targetAlias})` : targetAlias ? ` (now on ${targetAlias})` : ''}.`,
  ];

  if (title) {
    sections.push(`## Topic\n${sanitizeText(title)}`);
  }

  if (gitSnapshot) {
    const gitParts = [`Branch: \`${gitSnapshot.branch}\``];
    if (Array.isArray(gitSnapshot.recentCommits) && gitSnapshot.recentCommits.length > 0) {
      gitParts.push(`Recent commits:\n\`\`\`\n${gitSnapshot.recentCommits.join('\n')}\n\`\`\``);
    }
    if (gitSnapshot.status) {
      gitParts.push(`Working tree:\n\`\`\`\n${gitSnapshot.status}\n\`\`\``);
    } else {
      gitParts.push('Working tree: clean');
    }
    if (gitSnapshot.diffStat) {
      gitParts.push(`Diff stat:\n\`\`\`\n${gitSnapshot.diffStat}\n\`\`\``);
    }
    if (Array.isArray(gitSnapshot.changedFiles) && gitSnapshot.changedFiles.length > 0) {
      gitParts.push(`In-flight files: ${gitSnapshot.changedFiles.map((f) => `\`${f}\``).join(', ')}`);
    }
    sections.push(`## Git State\n${gitParts.join('\n')}`);
  }

  if (Array.isArray(artifacts) && artifacts.length > 0) {
    const artBlocks = artifacts.map(
      (a) => `### ${a.name} (\`${a.path}\`)\n${a.excerpt}${a.truncated ? '\n_(truncated — read file above if full detail is needed)_' : ''}`,
    );
    sections.push(`## Active Plan & Artifacts\n${artBlocks.join('\n\n')}`);
  }

  if (transcriptDigest) {
    sections.push(`## Recent Conversation Progress\n${transcriptDigest}`);
  } else if (conversationId) {
    sections.push(`## Previous Conversation\nPrevious conversation ID: \`${conversationId.slice(0, 12)}\` (no local transcript log found; inspect git state and workspace files first).`);
  }

  sections.push(
    '## Instructions\nReview the current workspace/git state, active artifacts, and recent progress above. Briefly confirm what is already done vs remaining, and continue immediately without repeating completed edits.',
  );

  return sections.join('\n\n');
}

export function prepareHandoff({
  cwd = process.cwd(),
  home = homedir(),
  baseDir = configDir(homedir()),
  fromAlias = null,
  targetAlias = null,
  execFile = execFileSync,
} = {}) {
  const conv = findLatestConversationForCwd(cwd, { home, baseDir });
  const transcriptDigest = conv.conversationId ? extractTranscriptDigest(conv.conversationId, { home }) : null;
  const artifacts = conv.conversationId ? extractBrainArtifactsSummary(conv.conversationId, { home }) : [];
  const gitSnapshot = collectGitHandoffSnapshot(cwd, { execFile });
  const prompt = buildHandoffPrompt({
    cwd,
    conversationId: conv.conversationId,
    title: conv.title,
    transcriptDigest,
    artifacts,
    gitSnapshot,
    fromAlias,
    targetAlias,
  });

  const savedPath = latestHandoffFilePath(baseDir);
  try {
    writeFileAtomic(savedPath, `${prompt}\n`, { mode: 0o600, dirMode: 0o700 });
  } catch {
    // Non-fatal if handoff cache cannot be saved.
  }

  return {
    prompt,
    savedPath,
    conversationId: conv.conversationId,
    title: conv.title,
    hasTranscript: Boolean(transcriptDigest),
    artifactCount: artifacts.length,
    hasGit: Boolean(gitSnapshot),
  };
}

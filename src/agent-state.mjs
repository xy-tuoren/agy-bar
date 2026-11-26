const MAIN_BUSY_STATES = Object.freeze(new Set(['working', 'tool_use', 'thinking']));
const STARTUP_STATES = Object.freeze(new Set(['authenticating', 'initializing']));
const RUNNING_SUBAGENT_STATUSES = Object.freeze(new Set(['running', 'working', 'active', 'in_progress']));

function nonNegNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function countRunningSubagents(payload) {
  const raw = payload?.subagents;
  if (!raw) return 0;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (Array.isArray(raw)) {
    let count = 0;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const st = String(item.status || item.state || '').trim().toLowerCase();
      if (item.running === true || RUNNING_SUBAGENT_STATUSES.has(st)) {
        count += 1;
      }
    }
    return count;
  }
  if (typeof raw === 'object') {
    const n = nonNegNumber(raw.running ?? raw.active);
    return n !== null ? Math.floor(n) : 0;
  }
  return 0;
}

export function countRunningTasks(payload) {
  const n = nonNegNumber(payload?.task_count);
  return n !== null ? Math.floor(n) : 0;
}

export function isToolConfirmationPending(payload) {
  return payload?.tool_confirmation_pending === true;
}

export function extractNativeCostUsd(payload) {
  const n = nonNegNumber(payload?.cost?.total_usd);
  return n !== null && n > 0 ? n : null;
}

/**
 * Single source of truth for classifying Antigravity CLI session activity across
 * tab titles, statusline badges, telemetry timers, and multi-CLI monitor.
 *
 * Official AGY agent_state values:
 *   idle | working | tool_use | reviewing | authenticating | initializing | error
 * Plus auxiliary live signals:
 *   tool_confirmation_pending, subagents[].status === 'running', task_count > 0
 */
export function classifyAgentActivity(payload = {}) {
  const raw = typeof payload?.agent_state === 'string' ? payload.agent_state.trim().toLowerCase() : '';
  const rawState = raw || 'idle';
  const runningSubagents = countRunningSubagents(payload);
  const runningTasks = countRunningTasks(payload);
  const confirmPending = isToolConfirmationPending(payload);

  if (confirmPending) {
    return Object.freeze({
      kind: 'confirm',
      rawState,
      needsAttention: true,
      isMainBusy: false,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: true,
      tabPrefix: '? ',
      statusBadge: 'CONFIRM',
      monitorLabel: 'confirm',
    });
  }

  if (rawState === 'reviewing') {
    return Object.freeze({
      kind: 'input',
      rawState,
      needsAttention: true,
      isMainBusy: false,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: '? ',
      statusBadge: 'INPUT',
      monitorLabel: 'input',
    });
  }

  if (rawState === 'error') {
    return Object.freeze({
      kind: 'error',
      rawState,
      needsAttention: true,
      isMainBusy: false,
      isActive: false,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: '✗ ',
      statusBadge: 'ERR',
      monitorLabel: 'error',
    });
  }

  if (MAIN_BUSY_STATES.has(rawState)) {
    return Object.freeze({
      kind: 'working',
      rawState,
      needsAttention: false,
      isMainBusy: true,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: '● ',
      statusBadge: null,
      monitorLabel: rawState,
    });
  }

  if (runningSubagents > 0) {
    return Object.freeze({
      kind: 'subagents',
      rawState,
      needsAttention: false,
      isMainBusy: false,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: `⚡${runningSubagents} `,
      statusBadge: null,
      monitorLabel: `sub:${runningSubagents}`,
    });
  }

  if (runningTasks > 0) {
    return Object.freeze({
      kind: 'tasks',
      rawState,
      needsAttention: false,
      isMainBusy: false,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: '● ',
      statusBadge: null,
      monitorLabel: `task:${runningTasks}`,
    });
  }

  if (STARTUP_STATES.has(rawState)) {
    return Object.freeze({
      kind: 'startup',
      rawState,
      needsAttention: false,
      isMainBusy: false,
      isActive: true,
      runningSubagents,
      runningTasks,
      confirmPending: false,
      tabPrefix: '… ',
      statusBadge: null,
      monitorLabel: rawState === 'authenticating' ? 'auth' : 'init',
    });
  }

  return Object.freeze({
    kind: 'idle',
    rawState,
    needsAttention: false,
    isMainBusy: false,
    isActive: false,
    runningSubagents,
    runningTasks,
    confirmPending: false,
    tabPrefix: '✓ ',
    statusBadge: null,
    monitorLabel: 'idle',
  });
}

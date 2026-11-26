import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAgentActivity,
  countRunningSubagents,
  countRunningTasks,
  extractNativeCostUsd,
} from '../src/agent-state.mjs';

test('classifyAgentActivity prioritizes confirmation, user input, error, working, subagents, tasks, startup, and true idle', () => {
  // 1. Tool confirmation pending takes top priority even if subagents are running.
  const confirm = classifyAgentActivity({
    agent_state: 'working',
    tool_confirmation_pending: true,
    subagents: [{ status: 'running' }, { status: 'running' }],
  });
  assert.equal(confirm.kind, 'confirm');
  assert.equal(confirm.needsAttention, true);
  assert.equal(confirm.isMainBusy, false);
  assert.equal(confirm.tabPrefix, '? ');
  assert.equal(confirm.statusBadge, 'CONFIRM');
  assert.equal(confirm.monitorLabel, 'confirm');
  assert.equal(confirm.runningSubagents, 2);

  // 2. Waiting for user review / question input.
  const input = classifyAgentActivity({ agent_state: 'reviewing' });
  assert.equal(input.kind, 'input');
  assert.equal(input.needsAttention, true);
  assert.equal(input.tabPrefix, '? ');
  assert.equal(input.statusBadge, 'INPUT');
  assert.equal(input.monitorLabel, 'input');

  // 3. Error state.
  const err = classifyAgentActivity({ agent_state: 'error' });
  assert.equal(err.kind, 'error');
  assert.equal(err.needsAttention, true);
  assert.equal(err.isActive, false);
  assert.equal(err.tabPrefix, '✗ ');
  assert.equal(err.statusBadge, 'ERR');

  // 4. Main agent busy.
  const busy = classifyAgentActivity({ agent_state: 'tool_use', subagents: [{ status: 'running' }] });
  assert.equal(busy.kind, 'working');
  assert.equal(busy.isMainBusy, true);
  assert.equal(busy.isActive, true);
  assert.equal(busy.tabPrefix, '● ');
  assert.equal(busy.statusBadge, null);

  // 5. Main agent idle while subagents are still running -> MUST NOT show completed checkmark.
  const subs = classifyAgentActivity({
    agent_state: 'idle',
    subagents: [
      { name: 'self', status: 'running' },
      { name: 'self', status: 'running' },
      { name: 'self', status: 'completed' },
      { name: 'research', status: 'in_progress' },
    ],
  });
  assert.equal(subs.kind, 'subagents');
  assert.equal(subs.isMainBusy, false);
  assert.equal(subs.isActive, true);
  assert.equal(subs.runningSubagents, 3);
  assert.equal(subs.tabPrefix, '⚡3 ');
  assert.equal(subs.monitorLabel, 'sub:3');

  // 6. Main agent idle while background tasks are running.
  const tasks = classifyAgentActivity({ agent_state: 'idle', task_count: 2 });
  assert.equal(tasks.kind, 'tasks');
  assert.equal(tasks.isActive, true);
  assert.equal(tasks.runningTasks, 2);
  assert.equal(tasks.tabPrefix, '● ');
  assert.equal(tasks.monitorLabel, 'task:2');

  // 7. Startup / authenticating states never show completed checkmark.
  const auth = classifyAgentActivity({ agent_state: 'authenticating' });
  assert.equal(auth.kind, 'startup');
  assert.equal(auth.tabPrefix, '… ');
  assert.equal(auth.monitorLabel, 'auth');

  const init = classifyAgentActivity({ agent_state: 'initializing' });
  assert.equal(init.kind, 'startup');
  assert.equal(init.tabPrefix, '… ');
  assert.equal(init.monitorLabel, 'init');

  // 8. Truly idle / complete.
  const idle = classifyAgentActivity({
    agent_state: 'idle',
    subagents: [{ status: 'completed' }],
    task_count: 0,
  });
  assert.equal(idle.kind, 'idle');
  assert.equal(idle.isActive, false);
  assert.equal(idle.needsAttention, false);
  assert.equal(idle.tabPrefix, '✓ ');
  assert.equal(idle.monitorLabel, 'idle');
});

test('helper extractors handle numeric, object, array, and missing values safely', () => {
  assert.equal(countRunningSubagents({ subagents: 4 }), 4);
  assert.equal(countRunningSubagents({ subagents: { running: 2 } }), 2);
  assert.equal(countRunningSubagents({ subagents: [{ running: true }, { status: 'completed' }] }), 1);
  assert.equal(countRunningSubagents({}), 0);

  assert.equal(countRunningTasks({ task_count: 3 }), 3);
  assert.equal(countRunningTasks({ task_count: -1 }), 0);

  assert.equal(extractNativeCostUsd({ cost: { total_usd: 1.42 } }), 1.42);
  assert.equal(extractNativeCostUsd({ cost: { total_usd: 0 } }), null);
  assert.equal(extractNativeCostUsd({}), null);
});

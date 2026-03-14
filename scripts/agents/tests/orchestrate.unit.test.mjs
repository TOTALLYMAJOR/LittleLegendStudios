import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBranchName,
  claimTask,
  createEmptyState,
  runWithRetry,
  selectDispatchTasks,
  shouldRunSmokeFromPaths
} from '../orchestrate.mjs';

test('buildBranchName uses required agent/<track>/<slug>-<date> format', () => {
  const task = {
    id: 't1',
    title: 'Add provider webhook retry contract tests',
    track: 'reliability'
  };

  const branch = buildBranchName(task, '20260314');
  assert.equal(branch, 'agent/reliability/add-provider-webhook-retry-contract-tests-20260314');
});

test('claimTask enforces lock semantics for active/completed claims', () => {
  const state = createEmptyState();
  const task = {
    id: 'task-1',
    title: 'Task 1',
    section: 'Next Up',
    line: 1,
    track: 'core'
  };

  assert.equal(claimTask(state, task, { status: 'queued', branchName: 'agent/core/task-1-20260314' }), true);
  assert.equal(claimTask(state, task, { status: 'queued' }), false);

  state.claims[task.id].status = 'completed';
  assert.equal(claimTask(state, task, { status: 'queued' }), false);
});

test('selectDispatchTasks respects parallel limits and task-id override', () => {
  const tasks = [
    { id: 'a', title: 'A', section: 'A', line: 1, track: 'general' },
    { id: 'b', title: 'B', section: 'A', line: 2, track: 'general' },
    { id: 'c', title: 'C', section: 'A', line: 3, track: 'general' }
  ];

  const state = createEmptyState();
  state.claims.a = { status: 'queued' };

  const selected = selectDispatchTasks(tasks, state, {
    maxParallel: 2,
    batchSize: 2
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'b');

  const selectedById = selectDispatchTasks(tasks, state, {
    taskId: 'c',
    maxParallel: 0,
    batchSize: 0
  });

  assert.equal(selectedById.length, 1);
  assert.equal(selectedById[0].id, 'c');
});

test('runWithRetry retries until success', async () => {
  let attempts = 0;

  const result = await runWithRetry(
    async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error('transient failure');
      }

      return 'ok';
    },
    {
      retries: 3,
      delayMs: 1,
      label: 'retry-test'
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('shouldRunSmokeFromPaths gates smoke checks to API/worker changes', () => {
  assert.equal(shouldRunSmokeFromPaths(['apps/web/app/page.tsx']), false);
  assert.equal(shouldRunSmokeFromPaths(['apps/api/src/index.ts']), true);
  assert.equal(shouldRunSmokeFromPaths(['apps/worker/src/index.ts']), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(process.cwd());

test('dry-run can generate runbook artifacts for first two architecture tasks', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'little-agents-'));

  try {
    const runsDir = path.join(tempRoot, 'runs');
    const stateFile = path.join(tempRoot, 'state.json');

    const command = spawnSync(
      'node',
      [
        'scripts/agents/orchestrate.mjs',
        '--mode=dry-run',
        '--tasks-file=TASKS.md',
        '--section=Architecture And Scale Hardening Backlog (2026-03-14)',
        '--batch-size=2',
        `--runs-dir=${runsDir}`,
        `--state-file=${stateFile}`,
        '--write-runbook=true',
        '--date=20260314'
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8'
      }
    );

    assert.equal(command.status, 0, command.stderr);

    const payload = JSON.parse(command.stdout);

    assert.equal(payload.mode, 'dry-run');
    assert.equal(payload.selected.length, 2);

    for (const task of payload.selected) {
      assert.ok(task.branchName.startsWith('agent/reliability/'));
      assert.ok(task.runDirectory);

      await stat(path.join(task.runDirectory, 'planner.prompt.md'));
      await stat(path.join(task.runDirectory, 'implementer.prompt.md'));
      await stat(path.join(task.runDirectory, 'reviewer.prompt.md'));
      await stat(path.join(task.runDirectory, 'pr-body.md'));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

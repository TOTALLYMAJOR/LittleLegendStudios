import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../orchestrate.mjs';

test('dry-run can generate runbook artifacts for first two architecture tasks', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'little-agents-'));

  try {
    const runsDir = path.join(tempRoot, 'runs');
    const stateFile = path.join(tempRoot, 'state.json');
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding));
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    };

    try {
      await runCli([
        '--mode=dry-run',
        '--tasks-file=TASKS.md',
        '--section=Architecture And Scale Hardening Backlog (2026-03-14)',
        '--batch-size=2',
        `--runs-dir=${runsDir}`,
        `--state-file=${stateFile}`,
        '--write-runbook=true',
        '--date=20260314'
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const payload = JSON.parse(chunks.join(''));

    assert.equal(payload.mode, 'dry-run');
    assert.equal(payload.selected.length, 2);

    for (const task of payload.selected) {
      assert.ok(task.branchName.startsWith('agent/reliability/'));
      assert.ok(task.runDirectory);

      await stat(path.join(task.runDirectory, 'planner.prompt.md'));
      await stat(path.join(task.runDirectory, 'implementer.prompt.md'));
      await stat(path.join(task.runDirectory, 'reviewer.prompt.md'));
      const prBodyPath = path.join(task.runDirectory, 'pr-body.md');
      await stat(prBodyPath);
      const prBody = await readFile(prBodyPath, 'utf8');
      assert.ok(prBody.includes('## Docs impact'));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

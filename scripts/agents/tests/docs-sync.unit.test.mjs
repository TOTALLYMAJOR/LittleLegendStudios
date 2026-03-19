import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectChangedFiles, evaluateDocsSync, extractMarkdownSection } from '../../check-docs-sync.mjs';

const BASE_README = [
  '# Repo',
  '',
  'See docs/runbooks/docs-governance.md for docs ownership.',
  '',
  '## Built Features',
  '- summary only',
  '',
  '## Remaining Work',
  '- tracked in TASKS.md'
].join('\n');

test('extractMarkdownSection returns lines for requested heading', () => {
  const lines = extractMarkdownSection(BASE_README, 'Built Features');
  assert.ok(lines.some((line) => line.includes('summary only')));
});

test('fails when behavior changes are missing TASKS update', () => {
  const result = evaluateDocsSync({
    changedFiles: ['apps/api/src/index.ts'],
    readmeText: BASE_README
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('TASKS.md')));
});

test('fails stack-sensitive changes when tech-stack and README are not both updated', () => {
  const result = evaluateDocsSync({
    changedFiles: ['apps/web/package.json', 'TASKS.md'],
    readmeText: BASE_README
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('README.md')));
  assert.ok(result.errors.some((entry) => entry.includes('tech-stack.md')));
});

test('passes env schema changes when env example and operator docs are updated', () => {
  const result = evaluateDocsSync({
    changedFiles: ['apps/api/src/env.ts', '.env.example', 'README.md', 'TASKS.md'],
    readmeText: BASE_README
  });

  assert.equal(result.ok, true);
});

test('fails when README built features section exceeds anti-redundancy limit', () => {
  const noisyReadme = [
    '# Repo',
    'docs/runbooks/docs-governance.md',
    '',
    '## Built Features',
    ...Array.from({ length: 20 }, (_, index) => `- duplicate detail ${index + 1}`),
    '',
    '## Remaining Work',
    '- tracked in TASKS.md'
  ].join('\n');

  const result = evaluateDocsSync({
    changedFiles: [],
    readmeText: noisyReadme
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes('Built Features section is too detailed')));
});

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('collectChangedFiles falls back to latest commit when base refs are missing', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docs-sync-git-'));

  try {
    runGit(tempRoot, ['init']);
    runGit(tempRoot, ['config', 'user.email', 'docs-sync@example.com']);
    runGit(tempRoot, ['config', 'user.name', 'Docs Sync Test']);

    await writeFile(path.join(tempRoot, 'README.md'), '# Base\n', 'utf8');
    await writeFile(path.join(tempRoot, 'scene-a.txt'), 'scene a\n', 'utf8');
    runGit(tempRoot, ['add', '.']);
    runGit(tempRoot, ['commit', '-m', 'initial']);

    await writeFile(path.join(tempRoot, 'scene-b.txt'), 'scene b\n', 'utf8');
    runGit(tempRoot, ['add', '.']);
    runGit(tempRoot, ['commit', '-m', 'add scene b']);

    const result = collectChangedFiles({
      cwd: tempRoot,
      baseRef: 'origin/main',
      env: {}
    });

    assert.equal(result.baseRef, '');
    assert.ok(result.changedFiles.includes('scene-b.txt'));
    assert.equal(result.changedFiles.includes('scene-a.txt'), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

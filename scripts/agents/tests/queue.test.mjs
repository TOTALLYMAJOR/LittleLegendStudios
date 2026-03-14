import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SECTION_ORDER,
  collectUncheckedTasks,
  parseChecklistTasks,
  slugify
} from '../queue.mjs';

test('slugify normalizes labels for task and branch IDs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  API/Worker Retry   Flow  '), 'api-worker-retry-flow');
});

test('parseChecklistTasks captures top-level checklist entries with section metadata', () => {
  const markdown = [
    '## A',
    '- [x] done item',
    '- [ ] pending item',
    '',
    '## B',
    '- [ ] second pending'
  ].join('\n');

  const tasks = parseChecklistTasks(markdown);

  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].section, 'A');
  assert.equal(tasks[1].checked, false);
  assert.equal(tasks[2].section, 'B');
});

test('collectUncheckedTasks prioritizes sections by configured order', () => {
  const markdown = [
    '## Next Up',
    '- [ ] next-1',
    '',
    '## Architecture And Scale Hardening Backlog (2026-03-14)',
    '- [ ] arch-1',
    '- [ ] arch-2',
    '',
    '## Something Else',
    '- [ ] other-1'
  ].join('\n');

  const tasks = collectUncheckedTasks(markdown, {
    sectionOrder: DEFAULT_SECTION_ORDER
  });

  assert.deepEqual(tasks.map((task) => task.title), ['arch-1', 'arch-2', 'next-1', 'other-1']);
  assert.deepEqual(tasks.map((task) => task.priority), [1, 2, 3, 4]);
});

test('collectUncheckedTasks supports exact section filters', () => {
  const markdown = [
    '## Next Up',
    '- [ ] next-1',
    '## Architecture And Scale Hardening Backlog (2026-03-14)',
    '- [ ] arch-1'
  ].join('\n');

  const tasks = collectUncheckedTasks(markdown, {
    section: 'Next Up'
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'next-1');
});

test('collectUncheckedTasks can restrict results to ordered sections only', () => {
  const markdown = [
    '## Next Up',
    '- [ ] next-1',
    '',
    '## Architecture And Scale Hardening Backlog (2026-03-14)',
    '- [ ] arch-1',
    '',
    '## Public Beta Safety Checklist (2026-03-13)',
    '- [ ] safety-1'
  ].join('\n');

  const tasks = collectUncheckedTasks(markdown, {
    sectionOrder: DEFAULT_SECTION_ORDER,
    restrictToSectionOrder: true
  });

  assert.deepEqual(tasks.map((task) => task.title), ['arch-1', 'next-1']);
});

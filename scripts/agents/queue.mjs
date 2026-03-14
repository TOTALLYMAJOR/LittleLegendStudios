import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SECTION_ORDER = [
  'Architecture And Scale Hardening Backlog (2026-03-14)',
  'Next Up'
];

const ROOT_SECTION = 'Unscoped';

function normalizeLabel(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function inferTrack(section) {
  if (section.startsWith('Architecture And Scale Hardening Backlog')) {
    return 'reliability';
  }

  if (section === 'Next Up') {
    return 'core';
  }

  return 'general';
}

export function buildTaskId(task) {
  const sectionSlug = slugify(task.section).slice(0, 40) || 'section';
  const titleSlug = slugify(task.title).slice(0, 72) || 'task';
  return `${sectionSlug}--${titleSlug}`;
}

export function parseChecklistTasks(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const sectionCounts = new Map();
  let currentSection = ROOT_SECTION;
  const tasks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);

    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const checklistMatch = /^- \[( |x|X)\]\s+(.+?)\s*$/.exec(line);

    if (!checklistMatch) {
      continue;
    }

    const checked = checklistMatch[1].toLowerCase() === 'x';
    const title = checklistMatch[2];
    const sectionOrdinal = (sectionCounts.get(currentSection) ?? 0) + 1;
    sectionCounts.set(currentSection, sectionOrdinal);

    tasks.push({
      title,
      checked,
      section: currentSection,
      line: index + 1,
      sectionOrdinal,
      track: inferTrack(currentSection)
    });
  }

  return tasks.map((task) => ({ ...task, id: buildTaskId(task) }));
}

export function orderTasks(tasks, sectionOrder = DEFAULT_SECTION_ORDER) {
  const sectionRank = new Map();

  sectionOrder.forEach((section, index) => {
    sectionRank.set(normalizeLabel(section), index);
  });

  return [...tasks].sort((a, b) => {
    const aRank = sectionRank.get(normalizeLabel(a.section)) ?? Number.MAX_SAFE_INTEGER;
    const bRank = sectionRank.get(normalizeLabel(b.section)) ?? Number.MAX_SAFE_INTEGER;

    if (aRank !== bRank) {
      return aRank - bRank;
    }

    if (a.line !== b.line) {
      return a.line - b.line;
    }

    return a.title.localeCompare(b.title);
  });
}

export function collectUncheckedTasks(markdown, options = {}) {
  const { sectionOrder = DEFAULT_SECTION_ORDER, section, restrictToSectionOrder = false } = options;
  const allTasks = parseChecklistTasks(markdown).filter((task) => !task.checked);

  const orderSet = new Set(sectionOrder.map((entry) => normalizeLabel(entry)));

  const filteredTasks = allTasks.filter((task) => {
    if (section) {
      return normalizeLabel(task.section) === normalizeLabel(section);
    }

    if (restrictToSectionOrder) {
      return orderSet.has(normalizeLabel(task.section));
    }

    return true;
  });

  const orderedTasks = orderTasks(filteredTasks, sectionOrder);

  return orderedTasks.map((task, index) => ({
    ...task,
    priority: index + 1
  }));
}

export async function loadUncheckedTasks(options = {}) {
  const {
    tasksFile = 'TASKS.md',
    section,
    sectionOrder = DEFAULT_SECTION_ORDER,
    restrictToSectionOrder = false
  } = options;
  const resolvedPath = path.resolve(process.cwd(), tasksFile);
  const markdown = await readFile(resolvedPath, 'utf8');
  return collectUncheckedTasks(markdown, { section, sectionOrder, restrictToSectionOrder });
}

function parseArgs(argv) {
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }

    const [key, inlineValue] = token.slice(2).split('=');

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }

    const nextToken = argv[index + 1];

    if (!nextToken || nextToken.startsWith('--')) {
      result[key] = 'true';
      continue;
    }

    result[key] = nextToken;
    index += 1;
  }

  return result;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function formatHuman(tasks) {
  if (tasks.length === 0) {
    return 'No unchecked tasks matched the query.';
  }

  return tasks
    .map(
      (task) =>
        `${String(task.priority).padStart(2, '0')}. [${task.section}] ${task.title} (id: ${task.id}, line: ${task.line})`
    )
    .join('\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'list';

  if (command !== 'list') {
    throw new Error(`Unsupported command: ${command}. Supported: list`);
  }

  const tasks = await loadUncheckedTasks({
    tasksFile: args['tasks-file'] ?? 'TASKS.md',
    section: args.section
  });

  const asJson = parseBool(args.json, false);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatHuman(tasks)}\n`);
}

const isCliEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isCliEntrypoint) {
  runCli().catch((error) => {
    process.stderr.write(`[agents:queue] ${error.message}\n`);
    process.exitCode = 1;
  });
}

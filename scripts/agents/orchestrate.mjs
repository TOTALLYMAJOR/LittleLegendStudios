import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { DEFAULT_SECTION_ORDER, loadUncheckedTasks, slugify } from './queue.mjs';
import { createRunArtifacts } from './runbook.mjs';

const ACTIVE_STATUSES = new Set([
  'queued',
  'planned',
  'implementing',
  'verifying',
  'reviewing',
  'releasing'
]);

const DEFAULT_REQUIRED_PR_HEADINGS = [
  '## Summary',
  '## Files changed',
  '## Risks / follow-ups',
  '## Commands run',
  '## Tests/lint/build results'
];

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

    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }

    result[key] = next;
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

function parseInteger(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function dateStamp(date = new Date()) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function buildBranchName(task, stamp = dateStamp()) {
  const trackSlug = slugify(task.track || 'general').slice(0, 24) || 'general';
  const titleSlug = slugify(task.title || task.id || 'task').slice(0, 48) || 'task';
  return `agent/${trackSlug}/${titleSlug}-${stamp}`;
}

export function shouldRunSmokeFromPaths(paths) {
  return paths.some((entry) => entry.startsWith('apps/api/') || entry.startsWith('apps/worker/'));
}

export function createEmptyState() {
  return {
    version: 1,
    claims: {},
    history: []
  };
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function countActiveClaims(state) {
  return Object.values(state.claims).filter((claim) => ACTIVE_STATUSES.has(claim.status)).length;
}

export function claimTask(state, task, meta = {}) {
  const existing = state.claims[task.id];

  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    return false;
  }

  if (existing && ['completed', 'released'].includes(existing.status)) {
    return false;
  }

  const timestamp = meta.timestamp ?? nowIso();

  state.claims[task.id] = {
    taskId: task.id,
    title: task.title,
    section: task.section,
    line: task.line,
    track: task.track,
    status: meta.status ?? 'queued',
    branchName: meta.branchName ?? '',
    runDirectory: meta.runDirectory ?? '',
    attempts: (existing?.attempts ?? 0) + 1,
    claimedAt: existing?.claimedAt ?? timestamp,
    updatedAt: timestamp,
    lastError: ''
  };

  state.history.push({
    event: 'claim',
    taskId: task.id,
    status: state.claims[task.id].status,
    timestamp
  });

  return true;
}

function updateClaim(state, taskId, patch, event) {
  const claim = state.claims[taskId];

  if (!claim) {
    return;
  }

  Object.assign(claim, patch, { updatedAt: nowIso() });

  if (event) {
    state.history.push({
      event,
      taskId,
      status: claim.status,
      timestamp: claim.updatedAt,
      message: patch.lastError || ''
    });
  }
}

export function selectDispatchTasks(allTasks, state, options = {}) {
  const { taskId, maxParallel = 2, batchSize = 1 } = options;

  if (taskId) {
    const exact = allTasks.find((task) => task.id === taskId);

    if (!exact) {
      throw new Error(`Task ID not found in unchecked queue: ${taskId}`);
    }

    return [exact];
  }

  const activeClaims = countActiveClaims(state);
  const availableSlots = Math.max(0, maxParallel - activeClaims);
  const limit = Math.min(batchSize, availableSlots);

  if (limit <= 0) {
    return [];
  }

  const candidates = allTasks.filter((task) => {
    const claim = state.claims[task.id];

    if (!claim) {
      return true;
    }

    return ['failed', 'blocked', 'skipped'].includes(claim.status);
  });

  return candidates.slice(0, limit);
}

export async function runWithRetry(fn, options = {}) {
  const {
    retries = 2,
    delayMs = 1500,
    label = 'stage'
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt > retries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastError?.message || 'unknown error'}`);
}

function hasCommand(commandName) {
  const check = spawnSync('bash', ['-lc', `command -v ${commandName}`], {
    stdio: 'ignore'
  });

  return check.status === 0;
}

async function runShell(command, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    logFile
  } = options;

  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `\n$ ${command}\n`, 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', async (chunk) => {
      await appendFile(logFile, chunk, 'utf8');
    });

    child.stderr.on('data', async (chunk) => {
      await appendFile(logFile, chunk, 'utf8');
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code });
        return;
      }

      reject(new Error(`Command failed (${code}): ${command}`));
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function getChangedPaths() {
  const output = await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'git diff --name-only'], {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    let collected = '';

    child.stdout.on('data', (chunk) => {
      collected += chunk.toString('utf8');
    });

    child.on('close', () => {
      resolve(collected);
    });

    child.on('error', () => {
      resolve('');
    });
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureCleanWorkingTree() {
  const output = await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'git status --short'], {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    let collected = '';

    child.stdout.on('data', (chunk) => {
      collected += chunk.toString('utf8');
    });

    child.on('close', () => {
      resolve(collected.trim());
    });

    child.on('error', () => {
      resolve('dirty');
    });
  });

  if (output.length > 0) {
    throw new Error('Working tree must be clean before dispatch. Commit or stash changes first.');
  }
}

function validatePrBody(bodyText) {
  const missing = DEFAULT_REQUIRED_PR_HEADINGS.filter((heading) => !bodyText.includes(heading));
  return missing;
}

async function releaseTask(task, context) {
  const { automerge, runDirectory, env, logFile } = context;

  if (!hasCommand('gh')) {
    throw new Error('GitHub CLI `gh` is required for release stage.');
  }

  const prBodyPath = path.join(runDirectory, 'pr-body.md');
  const prBody = await readFile(prBodyPath, 'utf8');
  const missingHeadings = validatePrBody(prBody);

  if (missingHeadings.length > 0) {
    throw new Error(`PR body is missing required headings: ${missingHeadings.join(', ')}`);
  }

  const commitMessage = `agent: ${task.title}`;
  const safeTitle = task.title.replace(/"/g, '\\"');

  const commands = [
    `git add -A`,
    `git commit -m "${commitMessage.replace(/"/g, '\\"')}" || true`,
    `git push -u origin "${task.branchName}"`,
    `gh pr create --title "agent: ${safeTitle}" --body-file "${prBodyPath}" --base main --head "${task.branchName}" --label agent:auto`
  ];

  for (const command of commands) {
    await runShell(command, { env, logFile });
  }

  if (automerge) {
    await runShell(`gh pr merge --auto --squash "${task.branchName}"`, { env, logFile });
  }
}

async function runPipelineForTask(task, options) {
  const {
    runDirectory,
    runLogPath,
    automerge,
    execute,
    state,
    env,
    retries
  } = options;

  if (!execute) {
    updateClaim(state, task.id, { status: 'planned', runDirectory }, 'planned');
    return { taskId: task.id, status: 'planned', runDirectory, branchName: task.branchName };
  }

  const taskEnv = {
    ...env,
    TASK_ID: task.id,
    TASK_TITLE: task.title,
    TASK_SECTION: task.section,
    TASK_LINE: String(task.line),
    TASK_TRACK: task.track,
    TASK_BRANCH: task.branchName,
    RUN_DIR: runDirectory
  };

  const plannerCommand = env.AGENT_PLANNER_CMD;
  const implementerCommand = env.AGENT_IMPLEMENTER_CMD;
  const reviewerCommand = env.AGENT_REVIEWER_CMD ?? 'npm run changed-files';

  await runWithRetry(
    () => runShell(`git checkout -B "${task.branchName}"`, { env: taskEnv, logFile: runLogPath }),
    { retries, label: `${task.id}:branch` }
  );

  updateClaim(state, task.id, { status: 'planned', branchName: task.branchName, runDirectory }, 'planned');

  if (plannerCommand) {
    await runWithRetry(
      () => runShell(plannerCommand, { env: taskEnv, logFile: runLogPath }),
      { retries, label: `${task.id}:planner` }
    );
  }

  updateClaim(state, task.id, { status: 'implementing' }, 'implementing');

  if (!implementerCommand) {
    updateClaim(
      state,
      task.id,
      {
        status: 'blocked',
        lastError: 'AGENT_IMPLEMENTER_CMD is not configured. Set it to run the implementer agent command.'
      },
      'blocked'
    );

    return {
      taskId: task.id,
      status: 'blocked',
      branchName: task.branchName,
      runDirectory,
      reason: state.claims[task.id].lastError
    };
  }

  await runWithRetry(
    () => runShell(implementerCommand, { env: taskEnv, logFile: runLogPath }),
    { retries, label: `${task.id}:implementer` }
  );

  updateClaim(state, task.id, { status: 'verifying' }, 'verifying');

  await runWithRetry(() => runShell('npm run typecheck', { env: taskEnv, logFile: runLogPath }), {
    retries,
    label: `${task.id}:typecheck`
  });

  await runWithRetry(() => runShell('npm run build', { env: taskEnv, logFile: runLogPath }), {
    retries,
    label: `${task.id}:build`
  });

  const changedPaths = await getChangedPaths();

  if (shouldRunSmokeFromPaths(changedPaths)) {
    await runWithRetry(() => runShell('RUN_SMOKE=1 bash ./scripts/verify.sh', { env: taskEnv, logFile: runLogPath }), {
      retries,
      label: `${task.id}:smoke`
    });
  }

  updateClaim(state, task.id, { status: 'reviewing' }, 'reviewing');

  await runWithRetry(() => runShell(reviewerCommand, { env: taskEnv, logFile: runLogPath }), {
    retries,
    label: `${task.id}:reviewer`
  });

  updateClaim(state, task.id, { status: 'releasing' }, 'releasing');

  const customReleaseCommand = env.AGENT_RELEASE_CMD;

  if (customReleaseCommand) {
    await runWithRetry(() => runShell(customReleaseCommand, { env: taskEnv, logFile: runLogPath }), {
      retries,
      label: `${task.id}:release`
    });
  } else {
    await runWithRetry(
      () => releaseTask(task, { automerge, runDirectory, env: taskEnv, logFile: runLogPath }),
      {
        retries,
        label: `${task.id}:release`
      }
    );
  }

  updateClaim(state, task.id, { status: 'completed', lastError: '' }, 'completed');

  return {
    taskId: task.id,
    status: 'completed',
    branchName: task.branchName,
    runDirectory
  };
}

async function dispatchTasks(options) {
  const {
    tasksFile,
    section,
    sectionOrder,
    restrictToSectionOrder,
    maxParallel,
    batchSize,
    taskId,
    mode,
    runsDir,
    stateFile,
    automerge,
    execute,
    retries,
    date
  } = options;

  const uncheckedTasks = await loadUncheckedTasks({
    tasksFile,
    section,
    sectionOrder,
    restrictToSectionOrder
  });
  const state = await readJsonIfPresent(stateFile, createEmptyState());
  const selectedTasks = selectDispatchTasks(uncheckedTasks, state, {
    taskId,
    maxParallel,
    batchSize
  });

  if (mode === 'dry-run') {
    const preview = selectedTasks.map((task) => ({
      ...task,
      branchName: buildBranchName(task, date)
    }));

    if (parseBool(options.writeRunbook, false)) {
      for (const task of preview) {
        const runArtifacts = await createRunArtifacts({
          runsDir,
          task: {
            ...task,
            branchName: task.branchName
          }
        });

        task.runDirectory = runArtifacts.runDirectory;
      }
    }

    return {
      mode,
      selected: preview,
      activeClaims: countActiveClaims(state)
    };
  }

  await ensureCleanWorkingTree();

  const results = [];

  for (const task of selectedTasks) {
    const branchName = buildBranchName(task, date);
    const claimed = claimTask(state, task, {
      status: 'queued',
      branchName
    });

    if (!claimed) {
      results.push({ taskId: task.id, status: 'skipped', reason: 'already active or completed' });
      continue;
    }

    const runArtifacts = await createRunArtifacts({
      runsDir,
      task: {
        ...task,
        branchName
      }
    });

    updateClaim(state, task.id, { runDirectory: runArtifacts.runDirectory, branchName }, 'runbook');

    const runLogPath = path.join(runArtifacts.runDirectory, 'run.log');

    try {
      const outcome = await runPipelineForTask(
        { ...task, branchName },
        {
          runDirectory: runArtifacts.runDirectory,
          runLogPath,
          automerge,
          execute,
          state,
          env: process.env,
          retries
        }
      );

      results.push(outcome);
    } catch (error) {
      updateClaim(
        state,
        task.id,
        {
          status: 'failed',
          lastError: error.message
        },
        'failed'
      );

      results.push({ taskId: task.id, status: 'failed', error: error.message, runDirectory: runArtifacts.runDirectory });
    }

    await writeJson(stateFile, state);

    await runShell('git checkout main || true', {
      env: process.env,
      logFile: runLogPath
    }).catch(() => {});
  }

  await writeJson(stateFile, state);

  return {
    mode,
    selected: selectedTasks.map((task) => task.id),
    results,
    activeClaims: countActiveClaims(state)
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const mode = args.mode ?? 'dispatch';
  const profile = args.profile ?? 'reliability';

  if (!['dispatch', 'dry-run', 'resume'].includes(mode)) {
    throw new Error(`Unsupported --mode value: ${mode}`);
  }

  const tasksFile = args['tasks-file'] ?? 'TASKS.md';
  const runsDir = args['runs-dir'] ?? '.codex/runs';
  const stateFile = args['state-file'] ?? path.join(runsDir, 'state.json');
  const dateValue = args.date ?? dateStamp();

  const useReliabilityProfile = profile === 'reliability';
  const sectionOrder = DEFAULT_SECTION_ORDER;

  const options = {
    mode,
    profile,
    tasksFile,
    runsDir,
    stateFile,
    section: args.section,
    sectionOrder,
    restrictToSectionOrder: useReliabilityProfile && !args.section,
    taskId: args['task-id'],
    maxParallel: parseInteger(args['max-parallel'], 2),
    batchSize: parseInteger(args['batch-size'], 1),
    automerge: parseBool(args.automerge, false),
    execute: parseBool(args.execute, true),
    retries: parseInteger(args.retries, 1),
    writeRunbook: parseBool(args['write-runbook'], false),
    date: dateValue
  };

  if (mode === 'resume') {
    const state = await readJsonIfPresent(stateFile, createEmptyState());
    const blockedTasks = Object.values(state.claims).filter((claim) => ['blocked', 'failed'].includes(claim.status));

    if (blockedTasks.length === 0) {
      process.stdout.write(`${JSON.stringify({ mode, resumed: [] }, null, 2)}\n`);
      return;
    }

    const resumeTaskId = blockedTasks[0].taskId;
    const resumeResult = await dispatchTasks({
      ...options,
      mode: 'dispatch',
      taskId: resumeTaskId,
      execute: true
    });

    process.stdout.write(`${JSON.stringify(resumeResult, null, 2)}\n`);
    return;
  }

  const result = await dispatchTasks(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCliEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isCliEntrypoint) {
  runCli().catch((error) => {
    process.stderr.write(`[agents:orchestrate] ${error.message}\n`);
    process.exitCode = 1;
  });
}

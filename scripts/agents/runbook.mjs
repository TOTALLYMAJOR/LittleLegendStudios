import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function renderTemplate(template, replacements) {
  let rendered = template;

  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{{${placeholder}}}`).join(value);
  }

  return rendered;
}

async function loadPrompt(repoRoot, promptFile) {
  const promptPath = path.join(repoRoot, '.codex', 'prompts', promptFile);
  return readFile(promptPath, 'utf8');
}

function defaultPrBody(task) {
  return [
    `## Summary`,
    `- ${task.title}`,
    '',
    '## Files changed',
    '- (to be filled by agent)',
    '',
    '## Risks / follow-ups',
    '- (to be filled by agent)',
    '',
    '## Commands run',
    '- (to be filled by agent)',
    '',
    '## Tests/lint/build results',
    '- (to be filled by agent)'
  ].join('\n');
}

function defaultPipeline(task) {
  return {
    taskId: task.id,
    title: task.title,
    section: task.section,
    branch: task.branchName,
    status: 'planned',
    stages: [
      {
        id: 'planner',
        promptFile: 'planner.prompt.md',
        status: 'ready'
      },
      {
        id: 'implementer',
        promptFile: 'implementer.prompt.md',
        status: 'ready'
      },
      {
        id: 'verifier',
        commands: [
          'npm run typecheck',
          'npm run build',
          'RUN_SMOKE=1 bash ./scripts/verify.sh'
        ],
        status: 'ready'
      },
      {
        id: 'reviewer',
        promptFile: 'reviewer.prompt.md',
        status: 'ready'
      },
      {
        id: 'release',
        status: 'ready'
      }
    ]
  };
}

export async function createRunArtifacts(options) {
  const {
    repoRoot = process.cwd(),
    runsDir = '.codex/runs',
    task,
    createDir = true
  } = options;

  if (!task?.id || !task?.title) {
    throw new Error('createRunArtifacts requires task.id and task.title');
  }

  const runDirectory = path.resolve(repoRoot, runsDir, task.id);

  if (createDir) {
    await mkdir(runDirectory, { recursive: true });
  }

  const [planTemplate, implementTemplate, reviewTemplate, deployTemplate] = await Promise.all([
    loadPrompt(repoRoot, 'plan-feature.md'),
    loadPrompt(repoRoot, 'implement-slice.md'),
    loadPrompt(repoRoot, 'review-pr.md'),
    loadPrompt(repoRoot, 'deploy-checklist.md')
  ]);

  const plannerPrompt = renderTemplate(planTemplate, { FEATURE_REQUEST: task.title });
  const implementerPrompt = renderTemplate(implementTemplate, { FEATURE_REQUEST: task.title });
  const reviewerPrompt = reviewTemplate;
  const deployPrompt = renderTemplate(deployTemplate, { CHANGE_SUMMARY: task.title });

  const files = [
    {
      path: path.join(runDirectory, 'task.json'),
      contents: `${JSON.stringify(task, null, 2)}\n`
    },
    {
      path: path.join(runDirectory, 'pipeline.json'),
      contents: `${JSON.stringify(defaultPipeline(task), null, 2)}\n`
    },
    {
      path: path.join(runDirectory, 'planner.prompt.md'),
      contents: plannerPrompt
    },
    {
      path: path.join(runDirectory, 'implementer.prompt.md'),
      contents: implementerPrompt
    },
    {
      path: path.join(runDirectory, 'reviewer.prompt.md'),
      contents: reviewerPrompt
    },
    {
      path: path.join(runDirectory, 'deploy-checklist.prompt.md'),
      contents: deployPrompt
    },
    {
      path: path.join(runDirectory, 'pr-body.md'),
      contents: `${defaultPrBody(task)}\n`
    }
  ];

  await Promise.all(files.map((entry) => writeFile(entry.path, entry.contents, 'utf8')));

  return {
    runDirectory,
    files: files.map((entry) => entry.path)
  };
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

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'create';

  if (command !== 'create') {
    throw new Error(`Unsupported command: ${command}. Supported: create`);
  }

  const id = args['task-id'];
  const title = args.title;

  if (!id || !title) {
    throw new Error('create requires --task-id and --title');
  }

  const task = {
    id,
    title,
    section: args.section ?? 'Unscoped',
    line: Number(args.line ?? '0'),
    track: args.track ?? 'general',
    branchName: args.branch ?? ''
  };

  const result = await createRunArtifacts({
    repoRoot: args['repo-root'] ?? process.cwd(),
    runsDir: args['runs-dir'] ?? '.codex/runs',
    task
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCliEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isCliEntrypoint) {
  runCli().catch((error) => {
    process.stderr.write(`[agents:runbook] ${error.message}\n`);
    process.exitCode = 1;
  });
}

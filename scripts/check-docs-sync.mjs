import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const README_BUILT_FEATURES_MAX_NON_EMPTY_LINES = 16;

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

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
}

function parseLines(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupe(values) {
  return [...new Set(values)];
}

function refExists(ref, cwd) {
  const check = runGit(['rev-parse', '--verify', ref], cwd);
  return check.status === 0;
}

export function getBaseRefCandidates(options = {}) {
  const { explicitBaseRef, env = process.env } = options;
  const candidates = [];

  if (explicitBaseRef) {
    candidates.push(explicitBaseRef);
  }

  if (env.DOCS_BASE_REF) {
    candidates.push(env.DOCS_BASE_REF);
  }

  if (env.GITHUB_BASE_REF) {
    candidates.push(`origin/${env.GITHUB_BASE_REF}`);
    candidates.push(env.GITHUB_BASE_REF);
  }

  candidates.push('origin/main', 'main');

  return dedupe(candidates.filter(Boolean));
}

export function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const target = String(heading ?? '').trim().toLowerCase();
  const collected = [];
  let inSection = false;

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);

    if (headingMatch) {
      const current = headingMatch[1].trim().toLowerCase();

      if (inSection) {
        break;
      }

      if (current === target) {
        inSection = true;
      }

      continue;
    }

    if (inSection) {
      collected.push(line);
    }
  }

  return collected;
}

function hasExact(set, file) {
  return set.has(file);
}

function hasPrefix(set, prefix) {
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return [...set].some((entry) => entry.startsWith(normalized));
}

function hasRegex(set, pattern) {
  return [...set].some((entry) => pattern.test(entry));
}

function hasAny(changedSet, files) {
  return files.some((file) => hasExact(changedSet, file));
}

export function evaluateDocsSync(options = {}) {
  const {
    changedFiles = [],
    readmeText = '',
    maxReadmeFeatureLines = README_BUILT_FEATURES_MAX_NON_EMPTY_LINES
  } = options;

  const changedSet = new Set(changedFiles);
  const errors = [];
  const checks = [];

  const behaviorChanged =
    hasPrefix(changedSet, 'apps') ||
    hasPrefix(changedSet, 'packages') ||
    hasPrefix(changedSet, 'scripts') ||
    hasPrefix(changedSet, 'infra/sql') ||
    hasExact(changedSet, 'infra/docker-compose.yml');

  if (behaviorChanged) {
    checks.push('behavior-change');
    if (!hasExact(changedSet, 'TASKS.md')) {
      errors.push(
        'Behavior/runtime changes detected but TASKS.md was not updated. Update the canonical build ledger.'
      );
    }
  }

  const stackChanged =
    hasExact(changedSet, 'package-lock.json') ||
    hasRegex(changedSet, /^apps\/[^/]+\/package(-lock)?\.json$/) ||
    hasRegex(changedSet, /^packages\/[^/]+\/package(-lock)?\.json$/);

  if (stackChanged) {
    checks.push('stack-change');
    if (!hasExact(changedSet, 'README.md')) {
      errors.push('Stack-sensitive files changed but README.md was not updated.');
    }
    if (!hasExact(changedSet, 'docs/runbooks/tech-stack.md')) {
      errors.push('Stack-sensitive files changed but docs/runbooks/tech-stack.md was not updated.');
    }
  }

  const agentControlChanged =
    hasPrefix(changedSet, 'scripts/agents') ||
    hasRegex(changedSet, /^\.github\/workflows\/agent-.*\.yml$/) ||
    hasRegex(changedSet, /^\.github\/workflows\/codex-.*\.yml$/);

  if (agentControlChanged) {
    checks.push('agent-control-change');
    if (!hasExact(changedSet, 'docs/runbooks/agent-autopilot.md')) {
      errors.push('Agent control files changed but docs/runbooks/agent-autopilot.md was not updated.');
    }
  }

  const envSchemaChanged = hasAny(changedSet, ['apps/api/src/env.ts', 'apps/worker/src/env.ts']);

  if (envSchemaChanged) {
    checks.push('env-schema-change');
    if (!hasExact(changedSet, '.env.example')) {
      errors.push('Env schema changed but .env.example was not updated.');
    }

    const envDocsTouched = hasAny(changedSet, [
      'README.md',
      'TASKS.md',
      'docs/runbooks/deploy-railway.md',
      'docs/runbooks/local-dev.md'
    ]);

    if (!envDocsTouched) {
      errors.push('Env schema changed but no operator-facing docs were updated.');
    }
  }

  const builtFeaturesSection = extractMarkdownSection(readmeText, 'Built Features');
  const nonEmptyFeatureLines = builtFeaturesSection.filter((line) => line.trim().length > 0).length;

  if (nonEmptyFeatureLines > maxReadmeFeatureLines) {
    errors.push(
      `README Built Features section is too detailed (${nonEmptyFeatureLines} non-empty lines). Keep details in TASKS.md and keep README summary-only.`
    );
  }

  if (!readmeText.includes('docs/runbooks/docs-governance.md')) {
    errors.push('README.md must link to docs/runbooks/docs-governance.md for governance discoverability.');
  }

  return {
    ok: errors.length === 0,
    errors,
    checks: dedupe(checks)
  };
}

export function collectChangedFiles(options = {}) {
  const {
    cwd = process.cwd(),
    baseRefCandidates = getBaseRefCandidates({ explicitBaseRef: options.baseRef, env: options.env })
  } = options;

  let resolvedBaseRef = '';
  for (const candidate of baseRefCandidates) {
    if (refExists(candidate, cwd)) {
      resolvedBaseRef = candidate;
      break;
    }
  }

  const changed = [];

  if (resolvedBaseRef) {
    const fromBase = runGit(['diff', '--name-only', `${resolvedBaseRef}...HEAD`], cwd);
    changed.push(...parseLines(fromBase.stdout));
  } else {
    const hasHeadParent = runGit(['rev-parse', '--verify', 'HEAD^'], cwd).status === 0;
    if (hasHeadParent) {
      const fromLatestCommit = runGit(['diff', '--name-only', 'HEAD^', 'HEAD'], cwd);
      changed.push(...parseLines(fromLatestCommit.stdout));
    } else {
      const fromInitialCommit = runGit(['show', '--name-only', '--pretty=format:', 'HEAD'], cwd);
      changed.push(...parseLines(fromInitialCommit.stdout));
    }
  }

  const unstaged = runGit(['diff', '--name-only'], cwd);
  const staged = runGit(['diff', '--name-only', '--cached'], cwd);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd);

  changed.push(...parseLines(unstaged.stdout));
  changed.push(...parseLines(staged.stdout));
  changed.push(...parseLines(untracked.stdout));

  return {
    baseRef: resolvedBaseRef,
    changedFiles: dedupe(changed).sort()
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const asJson = parseBool(args.json, false);
  const maxReadmeFeatureLines = Number.parseInt(
    String(args['readme-max-lines'] ?? README_BUILT_FEATURES_MAX_NON_EMPTY_LINES),
    10
  );

  const { baseRef, changedFiles } = collectChangedFiles({
    cwd,
    baseRef: args['base-ref']
  });

  const readmePath = path.join(cwd, 'README.md');
  const readmeText = await readFile(readmePath, 'utf8');

  const evaluation = evaluateDocsSync({
    changedFiles,
    readmeText,
    maxReadmeFeatureLines: Number.isFinite(maxReadmeFeatureLines)
      ? maxReadmeFeatureLines
      : README_BUILT_FEATURES_MAX_NON_EMPTY_LINES
  });

  const payload = {
    ok: evaluation.ok,
    baseRef: baseRef || null,
    changedFiles,
    checks: evaluation.checks,
    errors: evaluation.errors
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (evaluation.ok) {
    const baseLabel = baseRef ? `base ${baseRef}` : 'working tree';
    process.stdout.write(`[docs-sync] OK (${changedFiles.length} changed files, ${baseLabel}).\n`);
  } else {
    process.stderr.write('[docs-sync] FAILED\n');
    for (const error of evaluation.errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.stderr.write('Run: npm run docs:check -- --json\n');
  }

  if (!evaluation.ok) {
    process.exitCode = 1;
  }
}

const isCliEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isCliEntrypoint) {
  runCli().catch((error) => {
    process.stderr.write(`[docs-sync] ${error.message}\n`);
    process.exitCode = 1;
  });
}

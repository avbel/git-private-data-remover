import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import process from 'node:process';
import { checkGitVersion, getCurrentBranch, getIndexFlag, isGitRepoClean, resolveRepoFile } from './git-utils.ts';
import { handleLineReplacement } from './line-mode.ts';
import { ICONS } from './prompts.ts';
import { handleFileRemoval } from './remove-mode.ts';
import { ENGINE_ENV_VAR } from './rewrite.ts';
import { installSignalHandlers } from './session.ts';
import { describeError } from './shell.ts';

const MIN_GIT_VERSION = '2.22.0';
const MIN_NODE_MAJOR = 26;

// Bun reports an older Node compatibility version (26.3 for Bun 1.4), so the
// guard only applies when actually running on Node.
function checkRuntime(): void {
  if (process.versions.bun) {
    return;
  }

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

  if (major < MIN_NODE_MAJOR) {
    console.error(`${ICONS.error} Node.js ${MIN_NODE_MAJOR} or newer is required (found ${process.versions.node}).`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkRuntime();
  installSignalHandlers();

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: {
        type: 'string',
        short: 'f',
      },
      lines: {
        type: 'string',
        short: 'l',
      },
      'dry-run': {
        type: 'boolean',
        short: 'd',
        default: false,
      },
      rm: {
        type: 'boolean',
        short: 'r',
      },
      'working-directory': {
        type: 'string',
        short: 'w',
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 0) {
    console.error(`${ICONS.error} Unexpected positional arguments: ${positionals.join(', ')}`);
    printUsage();
    process.exit(1);
  }

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const isRmOperation = values.rm === true;
  const lineSpecs = values.lines;

  if (!values['working-directory'] || !values.file) {
    console.error(`${ICONS.error} Error: --working-directory and --file are required`);
    printUsage();
    process.exit(1);
  }

  if (isRmOperation && lineSpecs) {
    console.error(`${ICONS.error} Error: --rm and --lines are mutually exclusive. Use one or the other.`);
    printUsage();
    process.exit(1);
  }

  if (!isRmOperation && (!lineSpecs || lineSpecs.trim() === '')) {
    console.error(`${ICONS.error} Error: --lines is required (unless using --rm)`);
    printUsage();
    process.exit(1);
  }

  const cwd = values['working-directory'];
  const dirExists = existsSync(cwd) && statSync(cwd).isDirectory();

  if (!dirExists) {
    console.error(`${ICONS.error} Working directory not found: ${cwd}`);
    process.exit(1);
  }

  process.chdir(cwd);
  console.log(`Working directory: ${cwd}`);

  await checkGitVersion(MIN_GIT_VERSION);

  const repoFile = await resolveRepoFile(values.file);
  process.chdir(repoFile.toplevel);
  console.log(`Repository root: ${repoFile.toplevel}`);

  const isClean = await isGitRepoClean();
  if (!isClean) {
    console.error(
      `${ICONS.error} Git repository has uncommitted changes. Please commit or stash them before running this tool.`,
    );
    process.exit(1);
  }

  const currentBranch = await getCurrentBranch();
  if (currentBranch === '') {
    console.error(`${ICONS.error} HEAD is detached. Check out a branch before running this tool.`);
    process.exit(1);
  }

  const file = repoFile.relativePath;
  const dryRun = values['dry-run'];

  if (!isRmOperation && !repoFile.tracked) {
    console.error(`${ICONS.error} File is not tracked by git: ${file}`);
    process.exit(1);
  }

  const indexFlag = isRmOperation ? undefined : await getIndexFlag(file);

  if (indexFlag) {
    console.error(
      `${ICONS.error} ${file} is marked ${indexFlag} in the index, so its working copy is not tracked by git status ` +
        'and would be overwritten. Clear the flag (git update-index --no-skip-worktree / --no-assume-unchanged) first.',
    );
    process.exit(1);
  }

  console.log(`Checking file: ${file}`);

  if (dryRun) {
    console.log('Running in DRY-RUN mode (no changes will be made)');
  }

  if (isRmOperation) {
    await handleFileRemoval(file, currentBranch, dryRun);
    return;
  }

  await handleLineReplacement(file, currentBranch, lineSpecs!, dryRun);
}

function printUsage(): void {
  console.log(`
Git Private Data Remover

Remove accidentally committed private data from git history by rewriting specific lines in their originating commits.

Usage:
  node src/index.ts [options]      (Node.js 26+)
  bun run src/index.ts [options]

Options:
  -w, --working-directory <path>  Directory of the git repository, or any directory inside it (required)
  -f, --file <path>     File containing private data, relative to the working directory (required)
  -l, --lines <spec>    Line number(s) to remove (required unless --rm, comma-separated)
                        Format: "10" for single line, "10-20" for range, "10,20-30" for multiple
  -r, --rm              Completely remove the file from the current branch's history
  -d, --dry-run         Show what would be changed without modifying history
  -h, --help            Show this help message

Environment:
  ${ENGINE_ENV_VAR}=auto|history|rebase
                        Line rewrites use "git history fixup" when Git 2.55+ provides it,
                        otherwise "git rebase -i". Set this to force one engine.

Examples:
  bun run src/index.ts -w . -f config.json -l 15
  bun run src/index.ts -w . -f .env -l 5,10-15 --dry-run
`);
}

main().catch((error) => {
  console.error('Unexpected error:', describeError(error));
  process.exit(1);
});

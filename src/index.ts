import { $ } from 'bun';
import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import process from 'node:process';
import { parseLineSpecs } from './parser.ts';
import {
  checkGitVersion,
  getLineBlameInfo,
  groupReplacementsByCommit,
  createBackupBranch,
  getCurrentBranch,
  hasRemoteCommits,
  isGitRepoClean,
  isRebaseInProgress,
  hasMergeCommitsInRange,
  purgeReflogAndGc,
  getCommitInfo,
  sortCommitsTopologically,
  getCommitsTouchingFile,
} from './git-utils.ts';
import {
  promptForReplacements,
  confirmAction,
  outro,
  cancel,
  ICONS,
  confirmCommit,
  warnMultiCommitRemoval,
} from './prompts.ts';
import { performRebase, performFileRemoval } from './rebase.ts';
import type { LineInfo } from './types.ts';

const MIN_GIT_VERSION = '2.0.0';

function installSignalHandlers(): void {
  const abort = async (signal: NodeJS.Signals) => {
    console.error(`\n${ICONS.warning} Received ${signal}, attempting to abort any in-progress rebase...`);
    try {
      if (await isRebaseInProgress()) {
        await $`git rebase --abort`.quiet();
        console.error(`${ICONS.error} Rebase aborted.`);
      }
    } catch {
      // best-effort
    }
    process.exit(130);
  };

  process.on('SIGINT', () => {
    void abort('SIGINT');
  });
  process.on('SIGTERM', () => {
    void abort('SIGTERM');
  });
}

async function main(): Promise<void> {
  installSignalHandlers();

  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
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

  const isClean = await isGitRepoClean();
  if (!isClean) {
    console.error(
      `${ICONS.error} Git repository has uncommitted changes. Please commit or stash them before running this tool.`,
    );
    process.exit(1);
  }

  const file = values.file;
  const dryRun = values['dry-run'];

  const fileExists = await Bun.file(file).exists();
  if (!fileExists) {
    console.error(`${ICONS.error} File not found: ${file}`);
    process.exit(1);
  }

  try {
    await $`git ls-files --error-unmatch ${file}`.quiet();
  } catch {
    console.error(`${ICONS.error} File is not tracked by git: ${file}`);
    process.exit(1);
  }

  console.log(`Checking file: ${file}`);

  if (dryRun) {
    console.log('Running in DRY-RUN mode (no changes will be made)');
  }

  if (isRmOperation) {
    await handleFileRemoval(file, dryRun);
    return;
  }

  console.log(`Line specs: ${lineSpecs}`);

  const ranges = parseLineSpecs(lineSpecs!);
  const lineInfos: LineInfo[][] = [];

  for (const range of ranges) {
    const info = await getLineBlameInfo(file, range);
    lineInfos.push(info);
  }

  const allLines = lineInfos.flat();

  if (allLines.length === 0) {
    cancel('No lines found matching the specified ranges');
    process.exit(1);
  }

  console.log(`\nFound ${allLines.length} line(s) to process`);

  const uniqueCommits = Array.from(new Set(allLines.map((line) => line.commitHash)));
  console.log(`Spanning ${uniqueCommits.length} commit(s)`);

  const orderedCommits = await sortCommitsTopologically(uniqueCommits);

  const linesByCommit = new Map<string, LineInfo[]>();
  for (const hash of orderedCommits) {
    linesByCommit.set(hash, []);
  }
  for (const line of allLines) {
    const bucket = linesByCommit.get(line.commitHash);
    if (bucket) {
      bucket.push(line);
    }
  }

  const confirmedCommits = new Set<string>();

  for (const [commitHash, lines] of linesByCommit) {
    const { subject } = await getCommitInfo(commitHash);
    const confirmed = await confirmCommit(commitHash, subject, lines);

    if (confirmed) {
      confirmedCommits.add(commitHash);
    }
  }

  if (confirmedCommits.size === 0) {
    cancel('No commits selected for modification');
    process.exit(0);
  }

  const filteredLines = allLines.filter((line) => confirmedCommits.has(line.commitHash));

  console.log(`\nProceeding with ${filteredLines.length} line(s) from ${confirmedCommits.size} commit(s)`);

  const replacements = await promptForReplacements(filteredLines);

  if (replacements.size === 0) {
    cancel('No replacements specified');
    process.exit(0);
  }

  const commitsToRewrite = await groupReplacementsByCommit(filteredLines, replacements);

  if (commitsToRewrite.length === 0) {
    cancel('No replacements specified');
    process.exit(0);
  }

  const earliestCommit = commitsToRewrite[0].commitHash;
  const hasMerges = await hasMergeCommitsInRange(earliestCommit);
  if (hasMerges) {
    console.error(
      `${ICONS.error} Merge commits exist in the rebase range. This tool does not support rewriting history that contains merge commits.`,
    );
    process.exit(1);
  }

  console.log(`\nWill rewrite ${commitsToRewrite.length} commit(s)`);

  for (const commit of commitsToRewrite) {
    console.log(`  Commit ${commit.commitHash.substring(0, 7)}: ${commit.lines.length} line(s)`);
  }

  const hasRemote = await hasRemoteCommits();
  const currentBranch = await getCurrentBranch();

  if (hasRemote) {
    console.warn(`\n${ICONS.warning} WARNING: This repository has a remote upstream.`);
    console.warn('Rewriting history will require force-pushing to the remote.');
    console.warn('This can affect other collaborators.');
    console.warn('Note: remote copies and existing clones still contain the private data after this operation.');
  }

  console.log(
    `\n${ICONS.info} If anything goes wrong during the rebase, you can always reset to the current state with:`,
  );
  console.log(`  git reset --hard ${currentBranch}`);

  if (dryRun) {
    const proceed = await confirmAction('Proceed with dry-run?');

    if (!proceed) {
      cancel('Dry-run cancelled');
      process.exit(0);
    }

    await performRebase(commitsToRewrite, file, true);
    outro('Dry-run completed. No changes were made.');
    process.exit(0);
  }

  const backupBranch = await createBackupBranch(currentBranch);

  console.log(`\nCreated backup branch: ${backupBranch}`);
  console.log(`If anything goes wrong, recover with: git reset --hard ${backupBranch}`);

  const proceed = await confirmAction(
    `Are you sure you want to rewrite history? This will modify ${commitsToRewrite.length} commit(s).`,
  );

  if (!proceed) {
    cancel('Operation cancelled');
    process.exit(0);
  }

  try {
    await performRebase(commitsToRewrite, file, false);
    console.log('\nRebase completed successfully.');

    console.warn(`\n${ICONS.warning} The backup branch ${backupBranch} still contains the ORIGINAL private data.`);
    const removeBackup = await confirmAction(`Remove backup branch ${backupBranch}?`, true);

    if (removeBackup) {
      await $`git branch -D ${backupBranch}`;
      console.log(`Backup branch ${backupBranch} removed.`);
    } else {
      console.warn(`${ICONS.warning} Backup branch retained. The private data remains recoverable via this branch.`);
    }

    console.log('\nExpiring reflog and compressing git storage...');
    await purgeReflogAndGc();
    console.log('Git storage compressed.');

    if (hasRemote) {
      console.warn(`\n${ICONS.warning} Remember to force-push your changes:`);
      console.warn(`  git push --force-with-lease origin ${currentBranch}`);
      console.warn(`${ICONS.warning} Any existing clones, forks, or cached refs still contain the original data.`);
    }

    outro('Done! Private data has been removed from local git history.');
  } catch (error) {
    console.error(`\n${ICONS.error} Error during rebase:`, error instanceof Error ? error.message : String(error));
    console.error('\nRestoring from backup branch...');

    try {
      if (await isRebaseInProgress()) {
        await $`git rebase --abort`.quiet();
      }
    } catch {
      // best-effort
    }

    await $`git reset --hard ${backupBranch}`;
    console.error(`Restored to backup branch: ${backupBranch}`);
    process.exit(1);
  }
}

async function handleFileRemoval(file: string, dryRun: boolean): Promise<void> {
  const commits = await getCommitsTouchingFile(file);

  if (commits.length === 0) {
    cancel('File was not found in git history');
    process.exit(0);
  }

  console.log(`File found in ${commits.length} commit(s)`);

  if (commits.length > 1) {
    const confirmed = await warnMultiCommitRemoval(commits.length);
    if (!confirmed) {
      cancel('Operation cancelled');
      process.exit(0);
    }
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would remove ${file} from ${commits.length} commit(s):`);
    for (const hash of commits) {
      const { subject } = await getCommitInfo(hash);
      console.log(`  ${hash.substring(0, 7)}: ${subject}`);
    }
    outro('Dry-run completed. No changes were made.');
    process.exit(0);
  }

  const hasRemote = await hasRemoteCommits();
  const currentBranch = await getCurrentBranch();

  if (hasRemote) {
    console.warn(`\n${ICONS.warning} WARNING: This repository has a remote upstream.`);
    console.warn('Rewriting history will require force-pushing to the remote.');
    console.warn('This can affect other collaborators.');
    console.warn('Note: remote copies and existing clones still contain the private data after this operation.');
  }

  console.log(
    `\n${ICONS.info} If anything goes wrong during the removal, you can always reset to the current state with:`,
  );
  console.log(`  git reset --hard ${currentBranch}`);

  const backupBranch = await createBackupBranch(currentBranch);

  console.log(`\nCreated backup branch: ${backupBranch}`);
  console.log(`If anything goes wrong, recover with: git reset --hard ${backupBranch}`);

  const proceed = await confirmAction(`Are you sure you want to permanently remove ${file} from all git history?`);

  if (!proceed) {
    cancel('Operation cancelled');
    process.exit(0);
  }

  try {
    await performFileRemoval(file, dryRun);

    console.log('\nFile removal completed successfully.');

    console.warn(`\n${ICONS.warning} The backup branch ${backupBranch} still contains the ORIGINAL private data.`);
    const removeBackup = await confirmAction(`Remove backup branch ${backupBranch}?`, true);

    if (removeBackup) {
      await $`git branch -D ${backupBranch}`;
      console.log(`Backup branch ${backupBranch} removed.`);
    } else {
      console.warn(`${ICONS.warning} Backup branch retained. The private data remains recoverable via this branch.`);
    }

    console.log('\nExpiring reflog and compressing git storage...');
    await purgeReflogAndGc();
    console.log('Git storage compressed.');

    if (hasRemote) {
      console.warn(`\n${ICONS.warning} Remember to force-push your changes:`);
      console.warn(`  git push --force-with-lease origin ${currentBranch}`);
      console.warn(`${ICONS.warning} Any existing clones, forks, or cached refs still contain the original data.`);
    }

    outro('Done! File has been removed from local git history.');
  } catch (error) {
    console.error(
      `\n${ICONS.error} Error during file removal:`,
      error instanceof Error ? error.message : String(error),
    );
    console.error('\nRestoring from backup branch...');

    try {
      if (await isRebaseInProgress()) {
        await $`git rebase --abort`.quiet();
      }
    } catch {
      // best-effort
    }

    await $`git reset --hard ${backupBranch}`;
    console.error(`Restored to backup branch: ${backupBranch}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
Git Private Data Remover

Remove accidentally committed private data from git history by rewriting specific lines in their originating commits.

Usage:
  bun run src/index.ts [options]

Options:
  -w, --working-directory <path>  Directory of the git repository (required)
  -f, --file <path>     File containing private data (required)
  -l, --lines <spec>    Line number(s) to remove (required unless --rm, comma-separated)
                        Format: "10" for single line, "10-20" for range, "10,20-30" for multiple
  -r, --rm              Completely remove the file from all git history
  -d, --dry-run         Show what would be changed without modifying history
  -h, --help            Show this help message

Examples:
  bun run src/index.ts -w . -f config.json -l 15
  bun run src/index.ts -w . -f .env -l 5,10-15 --dry-run
`);
}

main().catch((error) => {
  console.error('Unexpected error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

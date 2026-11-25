import process from 'node:process';
import { deriveNeedle } from './bytes.ts';
import { finalizeRewrite, type LeftoverFinder } from './finalize.ts';
import {
  createBackupBranch,
  dedupeLineInfos,
  findCommitsContainingLines,
  getCommitInfo,
  getLineBlameInfo,
  groupReplacementsByCommit,
  hasMergeCommitsInRange,
  hasRemoteCommits,
  sortCommitsTopologically,
} from './git-utils.ts';
import { assertLineRewriteInvariant } from './invariant.ts';
import { parseLineSpecs } from './parser.ts';
import { ICONS, cancel, confirmAction, confirmCommit, outro, promptForReplacements } from './prompts.ts';
import { chooseEngine, describeEngine, rewriteCommits } from './rewrite.ts';
import { findBlobsContaining } from './scan.ts';
import {
  beginRewrite,
  completeRun,
  endRewrite,
  interactiveDecisions,
  printBackupHint,
  restoreFromBackup,
  warnAboutRemote,
} from './session.ts';
import { git } from './shell.ts';
import type { CommitReplacements, ContentHit, LineInfo } from './types.ts';

async function selectLines(file: string, lineSpecs: string): Promise<LineInfo[]> {
  const lineInfos: LineInfo[] = [];

  for (const range of parseLineSpecs(lineSpecs)) {
    lineInfos.push(...(await getLineBlameInfo(file, range)));
  }

  return dedupeLineInfos(lineInfos);
}

async function confirmCommits(allLines: LineInfo[]): Promise<LineInfo[]> {
  const orderedCommits = await sortCommitsTopologically(Array.from(new Set(allLines.map((line) => line.commitHash))));
  console.log(`Spanning ${orderedCommits.length} commit(s)`);

  if (await hasMergeCommitsInRange(orderedCommits[0] as string)) {
    console.error(
      `${ICONS.error} Merge commits exist in the rewrite range. This tool does not support rewriting history that contains merge commits.`,
    );
    process.exit(1);
  }

  const confirmed = new Set<string>();

  for (const hash of orderedCommits) {
    const lines = allLines.filter((line) => line.commitHash === hash);
    const { subject } = await getCommitInfo(hash);

    if (await confirmCommit(hash, subject, lines)) {
      confirmed.add(hash);
    }
  }

  return allLines.filter((line) => confirmed.has(line.commitHash));
}

// Searches for the exact original lines in the file's history and, across every
// path, for the fragment the user removed, which also catches the secret where
// an older commit formatted the line differently.
function leftoverFinder(file: string, commits: CommitReplacements[]): LeftoverFinder {
  const originals = commits.flatMap((commit) => commit.lines.map((line) => line.originalContent));
  const needles = commits.flatMap((commit) =>
    commit.lines.flatMap((line) => deriveNeedle(line.originalContent, line.replacementContent) ?? []),
  );
  const files = [file, ...commits.map((commit) => commit.file ?? file)];

  return async (tipArgs) => {
    const exact = await findCommitsContainingLines(files, originals, tipArgs);
    const reported = new Set(exact.map((hit) => hit.hash));
    const fromBlobs: ContentHit[] = [];

    for (const hit of await findBlobsContaining(needles, tipArgs)) {
      const note = `a file contains the removed value (blob ${hit.blob.slice(0, 8)})`;
      const hashes = hit.commits.length > 0 ? hit.commits : [hit.blob];

      for (const hash of hashes.filter((candidate) => !reported.has(candidate))) {
        reported.add(hash);
        fromBlobs.push({ hash, file: '', lines: [], note });
      }
    }

    return [...exact, ...fromBlobs];
  };
}

async function parentOf(commit: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--verify', '--quiet', `${commit}^`], { nothrow: true });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

export async function handleLineReplacement(
  file: string,
  currentBranch: string,
  lineSpecs: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`Line specs: ${lineSpecs}`);

  const allLines = await selectLines(file, lineSpecs);

  if (allLines.length === 0) {
    cancel('No lines found matching the specified ranges');
    process.exit(1);
  }

  console.log(`\nFound ${allLines.length} line(s) to process`);
  const selectedLines = await confirmCommits(allLines);

  if (selectedLines.length === 0) {
    cancel('No commits selected for modification');
    process.exit(0);
  }

  console.log(`\nProceeding with ${selectedLines.length} line(s)`);

  const replacements = await promptForReplacements(selectedLines);
  const commits = await groupReplacementsByCommit(selectedLines, replacements);

  if (commits.length === 0) {
    cancel('No replacements specified');
    process.exit(0);
  }

  console.log(`\nWill rewrite ${commits.length} commit(s)`);

  for (const commit of commits) {
    console.log(`  Commit ${commit.commitHash.substring(0, 7)}: ${commit.lines.length} line(s)`);
  }

  const engine = await chooseEngine(commits, file);
  console.log(`\nRewrite engine: ${describeEngine(engine.engine)} (${engine.reason})`);

  const hasRemote = await hasRemoteCommits();
  warnAboutRemote(hasRemote);

  if (dryRun) {
    if (!(await confirmAction('Proceed with dry-run?'))) {
      cancel('Dry-run cancelled');
      process.exit(0);
    }

    await rewriteCommits(commits, file, engine, true);
    outro('Dry-run completed. No changes were made.');
    process.exit(0);
  }

  const proceed = await confirmAction(
    `Are you sure you want to rewrite history? This will modify ${commits.length} commit(s).`,
  );

  if (!proceed) {
    cancel('Operation cancelled');
    process.exit(0);
  }

  const base = await parentOf((commits[0] as CommitReplacements).commitHash);
  const backupBranch = await createBackupBranch(currentBranch);
  printBackupHint(backupBranch);
  beginRewrite(backupBranch);

  try {
    await rewriteCommits(commits, file, engine, false);
    await assertLineRewriteInvariant({
      backupRef: backupBranch,
      base,
      allowedPaths: [file, ...commits.map((commit) => commit.file ?? file)],
      headFile: file,
      headLines: commits.flatMap((commit) => commit.lines.map((line) => line.headLineNumber)),
    });
    endRewrite();
    console.log('\nHistory rewrite completed and verified.');
  } catch (error) {
    await restoreFromBackup(describeEngine(engine.engine), error, backupBranch);
  }

  const result = await finalizeRewrite(backupBranch, leftoverFinder(file, commits), interactiveDecisions);
  completeRun(result, currentBranch, hasRemote, 'Done! Private data has been removed from local git history.');
}

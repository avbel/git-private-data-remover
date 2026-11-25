import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { finalizeRewrite, type LeftoverFinder } from './finalize.ts';
import {
  createBackupBranch,
  getCommitInfo,
  getCommitsTouchingFileInRefs,
  getIndexFlag,
  hasRemoteCommits,
} from './git-utils.ts';
import { assertRemovalInvariant } from './invariant.ts';
import { ICONS, cancel, confirmAction, outro, warnMultiCommitRemoval } from './prompts.ts';
import { performFileRemoval } from './rebase.ts';
import { planFileRemoval } from './removal.ts';
import { collectPathBlobs, findReachableBlobs } from './scan.ts';
import {
  beginRewrite,
  completeRun,
  endRewrite,
  interactiveDecisions,
  printBackupHint,
  restoreFromBackup,
  warnAboutRemote,
} from './session.ts';
import type { ContentHit } from './types.ts';

interface WorkingCopy {
  content: Buffer;
  mode: number;
}

// filter-repo and filter-branch check out the rewritten HEAD, which deletes the
// tracked file from disk. That copy may be the only one left once the backup is
// deleted and storage purged, so it is put back as an untracked file.
export function snapshotWorkingCopy(file: string): WorkingCopy | undefined {
  if (!existsSync(file)) {
    return undefined;
  }

  const stat = lstatSync(file);

  if (!stat.isFile()) {
    console.warn(`${ICONS.warning} ${file} is not a regular file; it will not be preserved in the working tree.`);
    return undefined;
  }

  return { content: readFileSync(file), mode: stat.mode & 0o777 };
}

export function restoreWorkingCopy(file: string, copy: WorkingCopy | undefined): void {
  if (!copy || existsSync(file)) {
    return;
  }

  writeFileSync(file, copy.content);
  chmodSync(file, copy.mode);
  console.log(`${ICONS.info} Your working copy of ${file} was kept as an untracked file. Add it to .gitignore.`);
}

function leftoverFinder(paths: readonly string[], fileBlobs: ReadonlySet<string>): LeftoverFinder {
  return async (tipArgs) => {
    const hits: ContentHit[] = [];
    const reported = new Set<string>();

    for (const path of paths) {
      for (const hash of await getCommitsTouchingFileInRefs(path, tipArgs)) {
        reported.add(hash);
        hits.push({ hash, file: path, lines: [] });
      }
    }

    for (const hit of await findReachableBlobs(fileBlobs, tipArgs)) {
      const note = `contains a version of the removed file (blob ${hit.blob.slice(0, 8)})`;

      for (const hash of (hit.commits.length > 0 ? hit.commits : [hit.blob]).filter((h) => !reported.has(h))) {
        reported.add(hash);
        hits.push({ hash, file: '', lines: [], note });
      }
    }

    return hits;
  };
}

export async function handleFileRemoval(file: string, currentBranch: string, dryRun: boolean): Promise<void> {
  const plan = await planFileRemoval(file);

  if (plan.commits.length === 0) {
    cancel('File was not found in git history');
    process.exit(0);
  }

  for (const path of plan.paths) {
    const flag = await getIndexFlag(path);

    if (flag) {
      console.error(`${ICONS.error} ${path} is marked ${flag} in the index; clear that flag before running this tool.`);
      process.exit(1);
    }
  }

  console.log(`File found in ${plan.commits.length} commit(s)`);

  if (plan.paths.length > 1) {
    console.log(`The file had other names in history; all of them will be removed: ${plan.paths.join(', ')}`);
  }

  if (plan.commits.length > 1 && !(await warnMultiCommitRemoval(plan.commits.length))) {
    cancel('Operation cancelled');
    process.exit(0);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would remove ${plan.paths.join(', ')} from ${plan.commits.length} commit(s):`);
    for (const hash of plan.commits) {
      const { subject } = await getCommitInfo(hash);
      console.log(`  ${hash.substring(0, 7)}: ${subject}`);
    }
    outro('Dry-run completed. No changes were made.');
    process.exit(0);
  }

  const hasRemote = await hasRemoteCommits();
  warnAboutRemote(hasRemote);

  const proceed = await confirmAction(
    `Are you sure you want to permanently remove ${plan.paths.join(', ')} from the history of ${currentBranch}? ` +
      'Your working copy will be kept as an untracked file.',
  );

  if (!proceed) {
    cancel('Operation cancelled');
    process.exit(0);
  }

  const workingCopy = snapshotWorkingCopy(file);
  const fileBlobs = await collectPathBlobs(plan.paths);
  const backupBranch = await createBackupBranch(currentBranch);
  printBackupHint(backupBranch);
  beginRewrite(backupBranch);

  try {
    await performFileRemoval(plan.paths, currentBranch);
    await assertRemovalInvariant(backupBranch, plan.paths);
    endRewrite();
    console.log('\nFile removal completed and verified.');
  } catch (error) {
    await restoreFromBackup('file removal', error, backupBranch);
  }

  restoreWorkingCopy(file, workingCopy);

  const result = await finalizeRewrite(backupBranch, leftoverFinder(plan.paths, fileBlobs), interactiveDecisions);
  completeRun(result, currentBranch, hasRemote, 'Done! File has been removed from local git history.');
}

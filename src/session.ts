import process from 'node:process';
import type { FinalizeDecisions, FinalizeResult } from './finalize.ts';
import { isRebaseInProgress } from './git-utils.ts';
import { ICONS, confirmAction, outro } from './prompts.ts';
import { describeError, git, terminateRunningCommands } from './shell.ts';

// Set from the moment history starts changing until the safety check after the
// rewrite passes. While set, an interrupt must put the branch back on the
// backup: `git history fixup` loops and filter-repo leave no rebase state that
// `git rebase --abort` could undo.
let activeBackup: string | undefined;
let restoring: Promise<void> | undefined;

export function beginRewrite(backupBranch: string): void {
  activeBackup = backupBranch;
}

export function endRewrite(): void {
  activeBackup = undefined;
}

// The interrupt also reaches the running git child, so the signal handler and
// the failing rewrite's catch block can both ask for a restore; run it once.
function restoreOnce(backupBranch: string): Promise<void> {
  restoring ??= (async () => {
    if (await isRebaseInProgress()) {
      await git(['rebase', '--abort'], { nothrow: true });
    }

    await git(['reset', '--hard', backupBranch], { echo: true });
    console.error(`Restored to backup branch: ${backupBranch}`);
  })();

  return restoring;
}

export async function restoreFromBackup(operation: string, error: unknown, backupBranch: string): Promise<never> {
  endRewrite();
  console.error(`\n${ICONS.error} Error during ${operation}:`, describeError(error));
  console.error('\nRestoring from backup branch...');
  await restoreOnce(backupBranch);
  process.exit(1);
}

export function installSignalHandlers(): void {
  const abort = async (signal: NodeJS.Signals): Promise<void> => {
    const backup = activeBackup;

    try {
      if (restoring) {
        await restoring;
      } else if (backup) {
        console.error(`\n${ICONS.warning} Received ${signal} during the rewrite, restoring ${backup}...`);
        await terminateRunningCommands();
        await restoreOnce(backup);
      } else if (await isRebaseInProgress()) {
        console.error(`\n${ICONS.warning} Received ${signal}, aborting the in-progress rebase...`);
        await git(['rebase', '--abort']);
      }
    } catch (error) {
      console.error(`${ICONS.error} Automatic restore failed: ${describeError(error)}`);
      if (backup) {
        console.error(`Recover manually with: git reset --hard ${backup}`);
      }
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

export const interactiveDecisions: FinalizeDecisions = {
  removeBackup: (backupBranch) => confirmAction(`Remove backup branch ${backupBranch}?`, true),
  purgeStorage: (stashCount) =>
    confirmAction('Permanently purge reflogs and unreachable objects now?', stashCount === 0),
};

export function warnAboutRemote(hasRemote: boolean): void {
  if (!hasRemote) {
    return;
  }

  console.warn(`\n${ICONS.warning} WARNING: This repository has a remote upstream.`);
  console.warn('Rewriting history will require force-pushing to the remote.');
  console.warn('This can affect other collaborators.');
  console.warn('Note: remote copies and existing clones will still contain the private data after this operation.');
}

export function printBackupHint(backupBranch: string): void {
  console.log(`\nCreated backup branch: ${backupBranch}`);
  console.log(`If anything goes wrong, recover with: git reset --hard ${backupBranch}`);
}

export function completeRun(
  result: FinalizeResult,
  currentBranch: string,
  hasRemote: boolean,
  doneMessage: string,
): void {
  if (hasRemote && result.clean) {
    console.warn(`\n${ICONS.warning} Remember to force-push your changes:`);
    console.warn(`  git push --force-with-lease origin ${currentBranch}`);
    console.warn(`${ICONS.warning} Any existing clones, forks, or cached refs still contain the original data.`);
  }

  if (!result.clean) {
    outro(
      result.remoteOnly
        ? `Branch ${currentBranch} was rewritten; force-push it and follow the steps above to finish.`
        : `Branch ${currentBranch} was rewritten, but the private data is STILL reachable locally (see above).`,
    );
    process.exit(1);
  }

  outro(doneMessage);
}

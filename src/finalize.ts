import { getRefsContaining, listStashCommits, purgeReflogAndGc, scanTipArgs } from './git-utils.ts';
import { ICONS } from './prompts.ts';
import { git } from './shell.ts';
import type { ContentHit } from './types.ts';

export interface FinalizeDecisions {
  removeBackup(backupBranch: string): Promise<boolean>;
  purgeStorage(stashCount: number): Promise<boolean>;
}

export interface FinalizeResult {
  clean: boolean;
  backupKept: boolean;
  purged: boolean;
  /** Leftovers are held only by remote-tracking refs, the expected state before a force-push. */
  remoteOnly?: boolean;
}

export type LeftoverFinder = (tipArgs: readonly string[]) => Promise<ContentHit[]>;

const MANUAL_PURGE = 'git reflog expire --expire=now --all && git gc --prune=now';

// Order matters: verify while the backup still exists, delete the backup only
// once nothing else holds the data, and purge (which is irreversible and also
// destroys unrelated recoverable work) only with explicit consent.
export async function finalizeRewrite(
  backupBranch: string,
  findLeftovers: LeftoverFinder,
  decisions: FinalizeDecisions,
): Promise<FinalizeResult> {
  console.log('\nVerifying that no ref other than the backup branch still contains the private data...');
  const leftovers = await findLeftovers(await scanTipArgs(`refs/heads/${backupBranch}`));

  if (leftovers.length > 0) {
    const refs = await reportLeftovers(leftovers, backupBranch);
    const remoteOnly = refs.length > 0 && refs.every((ref) => ref.startsWith('refs/remotes/'));
    console.warn(`\n${ICONS.warning} Backup branch ${backupBranch} was kept and git storage was NOT purged.`);
    printNextSteps(backupBranch, remoteOnly);
    return { clean: false, backupKept: true, purged: false, remoteOnly };
  }

  console.log(`${ICONS.success} No ref other than the backup branch contains the private data.`);
  console.warn(`\n${ICONS.warning} The backup branch ${backupBranch} still contains the ORIGINAL private data.`);

  if (!(await decisions.removeBackup(backupBranch))) {
    console.warn(`${ICONS.warning} Backup branch retained. The private data remains recoverable via this branch.`);
    console.warn(`When you no longer need it: git branch -D ${backupBranch} && ${MANUAL_PURGE}`);
    return { clean: true, backupKept: true, purged: false };
  }

  await git(['branch', '-D', backupBranch]);
  console.log(`Backup branch ${backupBranch} removed.`);

  const stashCount = (await listStashCommits()).length;
  printPurgeWarning(stashCount);

  if (!(await decisions.purgeStorage(stashCount))) {
    console.warn(
      `${ICONS.warning} Storage not purged: the old objects stay in .git and are recoverable via the reflog.`,
    );
    console.warn(`To drop them later: ${MANUAL_PURGE}`);
    return { clean: true, backupKept: false, purged: false };
  }

  console.log('\nExpiring reflogs and compressing git storage...');
  await purgeReflogAndGc();
  console.log('Git storage compressed.');
  return { clean: true, backupKept: false, purged: true };
}

function printPurgeWarning(stashCount: number): void {
  console.warn(
    `\n${ICONS.warning} The original data is still stored in .git until reflogs expire and unreachable objects are pruned.`,
  );
  console.warn('Purging is irreversible and also permanently deletes, for the whole repository:');
  console.warn('  - every reflog entry (your undo history for all branches and HEAD)');
  console.warn('  - dropped stashes, deleted branches and any other dangling commits');

  if (stashCount > 0) {
    console.warn(
      `  - your stash list (${stashCount} entr${stashCount === 1 ? 'y' : 'ies'}); at most the newest stash survives`,
    );
  }
}

// Without these steps a run on an already-pushed branch dead-ends: the backup
// branch (still holding the secret) would never be offered for deletion, and a
// later `git push --all` would publish it again.
function printNextSteps(backupBranch: string, remoteOnly: boolean): void {
  if (remoteOnly) {
    console.warn('\nOnly remote-tracking refs still hold the old commits, which is expected until you force-push.');
  }

  console.warn('\nTo finish once the refs listed above no longer hold the data:');

  if (remoteOnly) {
    console.warn('  git push --force-with-lease          # publish the rewritten branch');
    console.warn('  git fetch --prune                    # drop stale remote-tracking refs');
  } else {
    console.warn('  (delete, rewrite or force-push the refs listed above, and drop affected stashes)');
  }

  console.warn(`  git branch -D ${backupBranch}`);
  console.warn(`  ${MANUAL_PURGE}`);
}

async function reportLeftovers(leftovers: ContentHit[], backupBranch: string): Promise<string[]> {
  const refs = new Set<string>();
  const backupRef = `refs/heads/${backupBranch}`;

  console.warn(`\n${ICONS.warning} The private data is still present in ${leftovers.length} commit(s):`);

  for (const hit of leftovers) {
    const detail =
      hit.note ?? (hit.lines.length > 0 ? `${hit.lines.length} original line(s) in ${hit.file}` : hit.file);
    console.warn(`  ${hit.hash.substring(0, 7)}: ${detail}`);

    for (const ref of await getRefsContaining(hit.hash)) {
      if (ref !== backupRef) {
        refs.add(ref);
      }
    }
  }

  if (refs.size > 0) {
    console.warn('\nThese commits are kept alive by:');
    for (const ref of refs) {
      console.warn(`  ${ref}`);
    }
  }

  console.warn(
    '\nCommon causes: the secret also appears in an older commit (e.g. it was edited or reformatted later, and only the most recent version was rewritten),',
  );
  console.warn(
    'other local branches, tags or stashes still contain it, or a remote-tracking ref still points at the old history.',
  );

  return Array.from(refs);
}

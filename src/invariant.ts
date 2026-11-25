import { git, gitText } from './shell.ts';

async function listRange(base: string | undefined, tip: string): Promise<string[]> {
  const range = base ? `${base}..${tip}` : tip;
  return (await gitText(['rev-list', '--reverse', '--topo-order', range])).trim().split('\n').filter(Boolean);
}

async function changedPaths(from: string, to: string): Promise<string[]> {
  const output = await git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to]);
  return output.stdout.split('\0').filter(Boolean);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface LineRewriteExpectation {
  backupRef: string;
  /** Parent of the oldest rewritten commit, or undefined when that commit is the root. */
  base: string | undefined;
  allowedPaths: readonly string[];
  headFile: string;
  headLines: readonly number[];
}

// Both engines keep every commit (`--empty=keep`, `--allow-empty`), so the old
// and new ranges pair up by position. Any difference beyond the targeted lines
// means an engine or encoding bug damaged data the user never asked to touch,
// and must be caught while the backup still exists.
export async function assertLineRewriteInvariant(expected: LineRewriteExpectation): Promise<void> {
  const before = await listRange(expected.base, expected.backupRef);
  const after = await listRange(expected.base, 'HEAD');

  if (before.length !== after.length) {
    throw new Error(
      `Safety check failed: the rewrite changed the number of commits (${before.length} → ${after.length})`,
    );
  }

  const allowed = new Set(expected.allowedPaths);

  for (const [index, oldCommit] of before.entries()) {
    const unexpected = (await changedPaths(oldCommit, after[index] as string)).filter((path) => !allowed.has(path));

    if (unexpected.length > 0) {
      throw new Error(
        `Safety check failed: commit ${oldCommit.slice(0, 8)} changed untargeted path(s): ${unexpected.join(', ')}`,
      );
    }
  }

  await assertOnlyTargetLinesChanged(expected.backupRef, expected.headFile, expected.headLines);
}

async function assertOnlyTargetLinesChanged(
  backupRef: string,
  file: string,
  headLines: readonly number[],
): Promise<void> {
  const targets = new Set(headLines);
  const diff = await gitText([
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    backupRef,
    'HEAD',
    '--',
    file,
  ]);

  for (const line of diff.split('\n')) {
    const hunk = line.match(HUNK_HEADER);

    if (!hunk) {
      continue;
    }

    const start = Number.parseInt(hunk[1] as string, 10);
    const oldCount = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
    const newCount = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
    const touched = Array.from({ length: oldCount }, (_, offset) => start + offset);

    if (oldCount !== newCount || oldCount === 0 || touched.some((lineNumber) => !targets.has(lineNumber))) {
      throw new Error(`Safety check failed: ${file} changed outside the targeted lines (${line.trim()})`);
    }
  }
}

// filter-repo may drop commits that only touched the removed paths, so commits
// cannot be paired; the final tree must still differ only by those paths.
export async function assertRemovalInvariant(backupRef: string, removedPaths: readonly string[]): Promise<void> {
  const allowed = new Set(removedPaths);
  const unexpected = (await changedPaths(backupRef, 'HEAD')).filter((path) => !allowed.has(path));

  if (unexpected.length > 0) {
    throw new Error(`Safety check failed: removal changed untargeted path(s): ${unexpected.join(', ')}`);
  }
}

import { getCommitsTouchingFile } from './git-utils.ts';
import { git } from './shell.ts';

export interface RemovalPlan {
  /** The requested path first, then every earlier name it had on this branch. */
  paths: string[];
  /** Commits that touched the file under any of its names. */
  commits: string[];
}

async function followedNames(file: string): Promise<string[]> {
  const output = await git(['log', '--follow', '--name-only', '-z', '--format=', '--', file], { nothrow: true });
  const names =
    output.exitCode === 0
      ? output.stdout
          .split('\0')
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
  return Array.from(new Set([file, ...names]));
}

async function commitsTouchingPath(path: string): Promise<string[]> {
  const output = await git(['log', '--format=%H', 'HEAD', '--', path], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

// Removing only the current name left the content in every commit from before a
// rename, while the tool reported success. Removing every earlier name is only
// safe while that name belonged to this file alone: if an unrelated file later
// reused it, `--path <old name>` would strip that innocent file from history.
export async function planFileRemoval(file: string): Promise<RemovalPlan> {
  const commits = await getCommitsTouchingFile(file);
  const followed = new Set(commits);
  const paths = await followedNames(file);

  for (const path of paths) {
    if (path === file) {
      continue;
    }

    const foreign = (await commitsTouchingPath(path)).filter((hash) => !followed.has(hash));

    if (foreign.length > 0) {
      const shown = foreign.map((hash) => hash.slice(0, 8)).join(', ');
      throw new Error(
        `${file} was previously named ${path}, but ${path} was also used by another file (commits ${shown}). ` +
          `Removing it would delete that file's history too. Remove ${path} separately with --rm after reviewing those commits.`,
      );
    }
  }

  return { paths, commits };
}

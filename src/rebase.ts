import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { applyLineEdits, readBlob, stageFileContent } from './blob.ts';
import { ICONS } from './prompts.ts';
import { describeError, git, gitText } from './shell.ts';
import type { CommitReplacements } from './types.ts';

const TODO_ENV_VAR = 'GIT_PRIVATE_DATA_REMOVER_TODO';

export async function rewriteCommit(
  commitHash: string,
  file: string,
  replacements: CommitReplacements['lines'],
): Promise<void> {
  const content = await readBlob('HEAD', file);
  const updated = applyLineEdits(content, replacements, `${file} in commit ${commitHash}`);

  await stageFileContent('HEAD', file, updated);
  await git(['commit', '--amend', '--no-edit', '--no-verify', '--allow-empty']);
}

async function isRootCommit(commitHash: string): Promise<boolean> {
  const result = await git(['rev-parse', '--verify', `${commitHash}^`], { nothrow: true });
  return result.exitCode !== 0;
}

export async function performRebase(commits: CommitReplacements[], file: string, dryRun: boolean): Promise<void> {
  if (commits.length === 0) {
    return;
  }

  const earliestCommit = commits[0].commitHash;
  const root = await isRootCommit(earliestCommit);

  const todoList = root ? await generateTodoListForRoot() : await generateTodoList(`${earliestCommit}^`);
  const modifiedTodo = modifyTodoForEdits(todoList, commits);

  if (dryRun) {
    console.log('\n[DRY RUN] Rebase plan:');
    console.log(modifiedTodo);
    return;
  }

  // A private mkdtemp directory (mode 0700) instead of a predictable name in the
  // shared temp dir, where another local user could plant a symlink or swap in
  // `exec` lines. Git runs the sequence editor through a shell, so the path is
  // passed via the environment rather than spliced into the command string.
  const todoDir = await mkdtemp(join(tmpdir(), 'git-private-data-remover-'));
  const todoFile = join(todoDir, 'git-rebase-todo');
  await writeFile(todoFile, modifiedTodo, { mode: 0o600 });

  const env = {
    [TODO_ENV_VAR]: todoFile,
    GIT_SEQUENCE_EDITOR: `cp -f -- "$${TODO_ENV_VAR}"`,
    GIT_EDITOR: 'true',
  };

  try {
    await git(['rebase', '-i', root ? '--root' : `${earliestCommit}^`], { env });

    for (const commit of commits) {
      await rewriteCommit(commit.commitHash, commit.file ?? file, commit.lines);
      await git(['rebase', '--continue'], { env });
    }
  } catch (error) {
    await git(['rebase', '--abort'], { env, nothrow: true });
    throw new Error(`Rebase failed: ${describeError(error)}`);
  } finally {
    await rm(todoDir, { recursive: true, force: true });
  }
}

async function generateTodoList(parentCommit: string): Promise<string> {
  const output = await gitText(['log', '--reverse', '--format=pick %H %s', `${parentCommit}..HEAD`]);
  return output.trim();
}

async function generateTodoListForRoot(): Promise<string> {
  const output = await gitText(['log', '--reverse', '--format=pick %H %s']);
  return output.trim();
}

function modifyTodoForEdits(todo: string, commits: CommitReplacements[]): string {
  const lines = todo.split('\n');
  const commitHashes = new Set(commits.map((c) => c.commitHash));

  return lines
    .map((line) => {
      const match = line.match(/^(pick|p)\s+([a-f0-9]+)/);

      if (match && commitHashes.has(match[2])) {
        return line.replace(/^(pick|p)/, 'edit');
      }

      return line;
    })
    .join('\n');
}

export async function isFilterRepoAvailable(): Promise<boolean> {
  const result = await git(['filter-repo', '--version'], { nothrow: true });
  return result.exitCode === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function performFileRemoval(paths: readonly string[], currentBranch: string): Promise<void> {
  const branchRef = `refs/heads/${currentBranch}`;
  const shown = paths.join(', ');

  if (await isFilterRepoAvailable()) {
    console.log(`Using git filter-repo to remove ${shown} from ${currentBranch}...`);
    const pathArgs = paths.flatMap((path) => ['--path', path]);
    const result = await git(['filter-repo', '--force', '--refs', branchRef, ...pathArgs, '--invert-paths'], {
      nothrow: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(`git filter-repo failed: ${result.stderr.trim()}`);
    }

    return;
  }

  console.log(`git filter-repo not available. Using git filter-branch to remove ${shown}...`);

  const otherBranches = (await gitText(['branch', '--format=%(refname:short)']))
    .trim()
    .split('\n')
    .filter((b) => b !== '' && b !== currentBranch);

  if (otherBranches.length > 0) {
    console.warn(
      `${ICONS.warning} Other branches exist (${otherBranches.join(', ')}). filter-branch will only rewrite the current branch.`,
    );
  }

  const filterCommand = `git rm --cached --ignore-unmatch --quiet -- ${paths.map(shellQuote).join(' ')}`;
  // The user has already confirmed; filter-branch's own deprecation warning
  // would only add a 10 second sleep before it starts.
  const result = await git(['filter-branch', '--force', '--index-filter', filterCommand, 'HEAD'], {
    nothrow: true,
    env: { FILTER_BRANCH_SQUELCH_WARNING: '1' },
  });

  if (result.exitCode !== 0) {
    throw new Error(`git filter-branch failed: ${result.stderr.trim()}`);
  }

  await git(['update-ref', '-d', `refs/original/${branchRef}`], { nothrow: true });
}

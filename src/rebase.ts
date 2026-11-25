import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { ICONS } from './prompts.ts';
import { describeError, git, gitText } from './shell.ts';
import type { CommitReplacements } from './types.ts';

export async function rewriteCommit(
  commitHash: string,
  file: string,
  replacements: CommitReplacements['lines'],
): Promise<void> {
  const content = (await gitText(['show', `HEAD:${file}`])).split('\n');

  for (const replacement of replacements) {
    const lineIndex = replacement.lineNumber - 1;

    if (lineIndex < 0 || lineIndex >= content.length) {
      throw new Error(`Line ${replacement.lineNumber} does not exist in ${file} at commit ${commitHash}`);
    }

    if (content[lineIndex] !== replacement.originalContent) {
      throw new Error(
        `Content mismatch at line ${replacement.lineNumber} of ${file} in commit ${commitHash}: the line does not match what git blame reported`,
      );
    }

    content[lineIndex] = replacement.replacementContent;
  }

  await writeFile(file, content.join('\n'));
  await git(['add', '--', file]);
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

  const todoFile = join(tmpdir(), `git-rebase-todo-${Date.now()}`);
  await writeFile(todoFile, modifiedTodo);

  const env = {
    ...process.env,
    GIT_SEQUENCE_EDITOR: `cp -f "${todoFile}"`,
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
    await unlink(todoFile).catch(() => {});
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

export async function performFileRemoval(filePath: string, currentBranch: string): Promise<void> {
  const branchRef = `refs/heads/${currentBranch}`;

  if (await isFilterRepoAvailable()) {
    console.log(`Using git filter-repo to remove ${filePath} from ${currentBranch}...`);
    const result = await git(['filter-repo', '--force', '--refs', branchRef, '--path', filePath, '--invert-paths'], {
      nothrow: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(`git filter-repo failed: ${result.stderr.trim()}`);
    }

    return;
  }

  console.log(`git filter-repo not available. Using git filter-branch to remove ${filePath}...`);

  const otherBranches = (await gitText(['branch', '--format=%(refname:short)']))
    .trim()
    .split('\n')
    .filter((b) => b !== '' && b !== currentBranch);

  if (otherBranches.length > 0) {
    console.warn(
      `${ICONS.warning} Other branches exist (${otherBranches.join(', ')}). filter-branch will only rewrite the current branch.`,
    );
  }

  const escapedPath = filePath.replace(/[\\"$`]/g, '\\$&');
  const filterCommand = `git rm --cached --ignore-unmatch --quiet -- "${escapedPath}"`;
  const result = await git(['filter-branch', '--force', '--index-filter', filterCommand, 'HEAD'], { nothrow: true });

  if (result.exitCode !== 0) {
    throw new Error(`git filter-branch failed: ${result.stderr.trim()}`);
  }

  await git(['update-ref', '-d', `refs/original/${branchRef}`], { nothrow: true });
}

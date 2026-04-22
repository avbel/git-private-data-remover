import { $ } from 'bun';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { CommitReplacements } from './types.ts';

export async function rewriteCommit(
  commitHash: string,
  file: string,
  replacements: CommitReplacements['lines'],
): Promise<void> {
  const committedContent = (await $`git show HEAD:${file}`.text()).split('\n');
  const workingContent = (await Bun.file(file).text()).split('\n');

  for (const replacement of replacements) {
    const lineIndex = replacement.lineNumber - 1;

    if (lineIndex < 0 || lineIndex >= committedContent.length) {
      throw new Error(`Line ${replacement.lineNumber} does not exist in commit ${commitHash}`);
    }

    if (committedContent[lineIndex] !== replacement.originalContent) {
      throw new Error(
        `Content mismatch at line ${replacement.lineNumber} in commit ${commitHash}. Expected: "${replacement.originalContent}", got: "${committedContent[lineIndex]}"`,
      );
    }

    workingContent[lineIndex] = replacement.replacementContent;
  }

  await Bun.write(file, workingContent.join('\n'));
  await $`git add ${file}`;
  await $`git commit --amend --no-edit --no-verify`;
}

async function isRootCommit(commitHash: string): Promise<boolean> {
  try {
    await $`git rev-parse ${commitHash}^`;
    return false;
  } catch {
    return true;
  }
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
  await Bun.write(todoFile, modifiedTodo);

  const env = {
    ...process.env,
    GIT_SEQUENCE_EDITOR: `cp -f "${todoFile}"`,
  };

  try {
    if (root) {
      await $`git rebase -i --root`.env(env);
    } else {
      await $`git rebase -i ${earliestCommit}^`.env(env);
    }

    for (const commit of commits) {
      await rewriteCommit(commit.commitHash, file, commit.lines);
      await $`git rebase --continue`.env(env);
    }
  } catch (error) {
    try {
      await $`git rebase --abort`.env(env).quiet();
    } catch {
      // rebase may not be in progress
    }
    throw new Error(`Rebase failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await unlink(todoFile).catch(() => {});
  }
}

async function generateTodoList(parentCommit: string): Promise<string> {
  const format = 'pick %H %s';
  const output = await $`git log --reverse --format=${format} ${parentCommit}..HEAD`.text();
  return output.trim();
}

async function generateTodoListForRoot(): Promise<string> {
  const format = 'pick %H %s';
  const output = await $`git log --reverse --format=${format}`.text();
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

import { $ } from 'bun'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CommitReplacements } from './types.ts'

export async function rewriteCommit(
  commitHash: string,
  file: string,
  replacements: CommitReplacements['lines'],
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would edit commit ${commitHash}:`)

    for (const replacement of replacements) {
      console.log(`    Line ${replacement.lineNumber}: "${replacement.originalContent}" -> "${replacement.replacementContent}"`)
    }

    return
  }

  const fileContent = (await Bun.file(file).text()).split('\n')

  for (const replacement of replacements) {
    const lineIndex = replacement.lineNumber - 1

    if (lineIndex < 0 || lineIndex >= fileContent.length) {
      throw new Error(
        `Line ${replacement.lineNumber} does not exist in the current working tree file`
      )
    }

    if (fileContent[lineIndex] !== replacement.originalContent) {
      throw new Error(
        `Content mismatch at line ${replacement.lineNumber} in commit ${commitHash}. Expected: "${replacement.originalContent}", got: "${fileContent[lineIndex]}"`
      )
    }

    fileContent[lineIndex] = replacement.replacementContent
  }

  await Bun.write(file, fileContent.join('\n'))
  await $`git add ${file}`
  await $`git commit --amend --no-edit --no-verify`
}

async function isRootCommit(commitHash: string): Promise<boolean> {
  try {
    await $`git rev-parse ${commitHash}^`
    return false
  } catch {
    return true
  }
}

export async function performRebase(
  commits: CommitReplacements[],
  file: string,
  dryRun: boolean
): Promise<void> {
  if (commits.length === 0) {
    return
  }

  const earliestCommit = commits[0].commitHash
  const root = await isRootCommit(earliestCommit)

  const todoList = root
    ? await generateTodoListForRoot()
    : await generateTodoList(`${earliestCommit}^`)
  const modifiedTodo = modifyTodoForEdits(todoList, commits)

  if (dryRun) {
    console.log('\n[DRY RUN] Rebase plan:')
    console.log(modifiedTodo)
    return
  }

  const todoFile = join(tmpdir(), `git-rebase-todo-${Date.now()}`)
  await Bun.write(todoFile, modifiedTodo)

  const env = {
    ...process.env,
    GIT_SEQUENCE_EDITOR: `cp -f "${todoFile}"`,
  }

  try {
    if (root) {
      await $`git rebase -i --root`.env(env)
    } else {
      await $`git rebase -i ${earliestCommit}^`.env(env)
    }

    for (const commit of commits) {
      await rewriteCommit(commit.commitHash, file, commit.lines, false)
      await $`git rebase --continue`.env(env)
    }
  } catch (error) {
    await $`git rebase --abort`.env(env)
    throw new Error(`Rebase failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await $`rm -f ${todoFile}`
  }
}

async function generateTodoList(parentCommit: string): Promise<string> {
  const format = 'pick %H %s'
  const output = await $`git log --reverse --format=${format} ${parentCommit}..HEAD`.text()
  return output.trim()
}

async function generateTodoListForRoot(): Promise<string> {
  const format = 'pick %H %s'
  const output = await $`git log --reverse --format=${format}`.text()
  return output.trim()
}

function modifyTodoForEdits(todo: string, commits: CommitReplacements[]): string {
  const lines = todo.split('\n')
  const commitHashes = new Set(commits.map(c => c.commitHash))

  return lines
    .map(line => {
      const match = line.match(/^(pick|p)\s+([a-f0-9]+)/)

      if (match && commitHashes.has(match[2])) {
        return line.replace(/^(pick|p)/, 'edit')
      }

      return line
    })
    .join('\n')
}

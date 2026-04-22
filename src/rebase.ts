import { $ } from 'bun'
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

  const fileContent = await getFileAtCommit(file, commitHash)

  for (const replacement of replacements) {
    const lineIndex = replacement.lineNumber - 1

    if (lineIndex < 0 || lineIndex >= fileContent.length) {
      throw new Error(
        `Line ${replacement.lineNumber} does not exist in commit ${commitHash}`
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

async function getFileAtCommit(file: string, commitHash: string): Promise<string[]> {
  const output = await $`git show ${commitHash}:${file}`.text()
  return output.split('\n')
}

export async function performRebase(
  commits: CommitReplacements[],
  file: string,
  dryRun: boolean
): Promise<void> {
  if (commits.length === 0) {
    return
  }

  const earliestCommit = commits[commits.length - 1].commitHash
  const parentCommit = `${earliestCommit}^`

  const todoList = await generateTodoList(parentCommit)
  const modifiedTodo = modifyTodoForEdits(todoList, commits)

  if (dryRun) {
    console.log('\n[DRY RUN] Rebase plan:')
    console.log(modifiedTodo)
    return
  }

  const todoFile = `/tmp/git-rebase-todo-${Date.now()}`
  await Bun.write(todoFile, modifiedTodo)

  const env = {
    ...process.env,
    GIT_SEQUENCE_EDITOR: `cat ${todoFile} >`,
  }

  try {
    await $`git rebase -i ${parentCommit}`.env(env)

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
  const output = await $`git rebase -i ${parentCommit}`.text()
  return output
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

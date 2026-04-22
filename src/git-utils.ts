import { $ } from 'bun'
import type { LineInfo, LineRange, Replacement, CommitReplacements } from './types.ts'

export async function checkGitVersion(minVersion: string): Promise<void> {
  const versionOutput = await $`git --version`.text()
  const match = versionOutput.match(/git version (\d+)\.(\d+)\.(\d+)/)

  if (!match) {
    throw new Error('Could not detect git version. Is git installed?')
  }

  const currentVersion = `${match[1]}.${match[2]}.${match[3]}`

  if (compareVersions(currentVersion, minVersion) < 0) {
    throw new Error(
      `Git version ${currentVersion} is too old. Minimum required: ${minVersion}`
    )
  }
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0
    const bPart = bParts[i] || 0

    if (aPart > bPart) return 1
    if (aPart < bPart) return -1
  }

  return 0
}

export async function getLineBlameInfo(
  file: string,
  lineRange: LineRange
): Promise<LineInfo[]> {
  const output = await $`git blame -L ${lineRange.start},${lineRange.end} -p -- ${file}`.text()
  const lines = output.trim().split('\n')
  const result: LineInfo[] = []
  let currentCommit = ''
  let currentOriginalLine = 0
  let currentFinalLine = 0

  for (const line of lines) {
    if (line.match(/^[a-f0-9]{40} /)) {
      const parts = line.split(' ')
      currentCommit = parts[0]
      currentOriginalLine = Number.parseInt(parts[1], 10)
      currentFinalLine = Number.parseInt(parts[2], 10)
    } else if (line.startsWith('\t')) {
      const content = line.substring(1)
      result.push({
        lineNumber: currentFinalLine,
        content,
        commitHash: currentCommit,
        originalLineNumber: currentOriginalLine,
      })
    }
  }

  return result
}

export async function getFileAtCommit(
  file: string,
  commitHash: string
): Promise<string[]> {
  const output = await $`git show ${commitHash}:${file}`.text()
  return output.split('\n')
}

export async function createBackupBranch(originalBranch: string): Promise<string> {
  const timestamp = Date.now()
  const backupBranch = `backup/${originalBranch}/${timestamp}`
  await $`git branch ${backupBranch}`
  return backupBranch
}

export async function getCurrentBranch(): Promise<string> {
  return (await $`git branch --show-current`.text()).trim()
}

export function groupReplacementsByCommit(
  lineInfos: LineInfo[],
  replacements: Map<number, string>
): CommitReplacements[] {
  const groups = new Map<string, Replacement[]>()

  for (const info of lineInfos) {
    const replacement = replacements.get(info.lineNumber)

    if (replacement === undefined) {
      continue
    }

    const existing = groups.get(info.commitHash) || []

    existing.push({
      lineNumber: info.originalLineNumber,
      originalContent: info.content,
      replacementContent: replacement,
    })

    groups.set(info.commitHash, existing)
  }

  return Array.from(groups.entries())
    .map(([commitHash, lines]) => ({ commitHash, lines }))
    .sort((a, b) => compareCommitOrder(a.commitHash, b.commitHash))
}

async function compareCommitOrder(a: string, b: string): Promise<number> {
  try {
    const output = await $`git rev-list --ancestry-path ${a}..${b}`.text()
    const count = output.trim().split('\n').filter(Boolean).length
    return count > 0 ? -1 : 1
  } catch {
    return 0
  }
}

export async function hasRemoteCommits(): Promise<boolean> {
  try {
    await $`git rev-parse --abbrev-ref --symbolic-full-name @{u}`
    return true
  } catch {
    return false
  }
}

export async function runGitGc(): Promise<void> {
  await $`git gc --aggressive --prune=now`
}

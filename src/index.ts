import { $ } from 'bun'
import { parseArgs } from 'util'
import { parseLineSpecs } from './parser.ts'
import {
  checkGitVersion,
  getLineBlameInfo,
  groupReplacementsByCommit,
  createBackupBranch,
  getCurrentBranch,
  hasRemoteCommits,
  isGitRepoClean,
  runGitGc,
  getCommitInfo,
} from './git-utils.ts'
import {
  promptForReplacements,
  confirmAction,
  outro,
  cancel,
  ICONS,
  confirmCommit,
} from './prompts.ts'
import { performRebase } from './rebase.ts'

const MIN_GIT_VERSION = '2.0.0'

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      file: {
        type: 'string',
        short: 'f',
      },
      lines: {
        type: 'string',
        short: 'l',
        multiple: true,
      },
      'dry-run': {
        type: 'boolean',
        short: 'd',
        default: false,
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values.help) {
    printUsage()
    process.exit(0)
  }

  if (!values.file || !values.lines || values.lines.length === 0) {
    console.error('Error: --file and --lines are required')
    printUsage()
    process.exit(1)
  }

  await checkGitVersion(MIN_GIT_VERSION)

  const isClean = await isGitRepoClean()
  if (!isClean) {
    console.error(`${ICONS.error} Git repository has uncommitted changes. Please commit or stash them before running this tool.`)
    process.exit(1)
  }

  const file = values.file
  const lineSpecs = values.lines
  const dryRun = values['dry-run']

  const fileExists = await Bun.file(file).exists()
  if (!fileExists) {
    console.error(`${ICONS.error} File not found: ${file}`)
    process.exit(1)
  }

  try {
    await $`git ls-files --error-unmatch ${file}`
  } catch {
    console.error(`${ICONS.error} File is not tracked by git: ${file}`)
    process.exit(1)
  }

  console.log(`Checking file: ${file}`)
  console.log(`Line specs: ${lineSpecs.join(', ')}`)

  if (dryRun) {
    console.log('Running in DRY-RUN mode (no changes will be made)')
  }

  const ranges = parseLineSpecs(lineSpecs)
  const lineInfos: Awaited<ReturnType<typeof getLineBlameInfo>>[] = []

  for (const range of ranges) {
    const info = await getLineBlameInfo(file, range)
    lineInfos.push(info)
  }

  const allLines = lineInfos.flat()

  if (allLines.length === 0) {
    cancel('No lines found matching the specified ranges')
    process.exit(1)
  }

  console.log(`\nFound ${allLines.length} line(s) to process`)

  const uniqueCommits = new Set(allLines.map(line => line.commitHash))
  console.log(`Spanning ${uniqueCommits.size} commit(s)`)

  const linesByCommit = new Map<string, typeof allLines>()
  for (const line of allLines) {
    const existing = linesByCommit.get(line.commitHash) || []
    existing.push(line)
    linesByCommit.set(line.commitHash, existing)
  }

  for (const [commitHash, lines] of linesByCommit) {
    const { subject } = await getCommitInfo(commitHash)
    const confirmed = await confirmCommit(commitHash, subject, lines)

    if (!confirmed) {
      cancel('Operation cancelled by user')
      process.exit(0)
    }
  }

  const replacements = await promptForReplacements(allLines)

  if (replacements.size === 0) {
    cancel('No replacements specified')
    process.exit(0)
  }

  const commitsToRewrite = await groupReplacementsByCommit(allLines, replacements)

  console.log(`\nWill rewrite ${commitsToRewrite.length} commit(s)`)

  for (const commit of commitsToRewrite) {
    console.log(`  Commit ${commit.commitHash.substring(0, 7)}: ${commit.lines.length} line(s)`)
  }

  const hasRemote = await hasRemoteCommits()
  const currentBranch = await getCurrentBranch()

  if (hasRemote) {
    console.warn(`\n${ICONS.warning} WARNING: This repository has a remote upstream.`)
    console.warn('Rewriting history will require force-pushing to the remote.')
    console.warn('This can affect other collaborators.')
  }

  console.log(`\n${ICONS.info} If anything goes wrong during the rebase, you can always reset to the current state with:`)
  console.log(`  git reset --hard ${currentBranch}`)

  if (dryRun) {
    const proceed = await confirmAction('Proceed with dry-run?')

    if (!proceed) {
      cancel('Dry-run cancelled')
      process.exit(0)
    }

    await performRebase(commitsToRewrite, file, true)
    outro('Dry-run completed. No changes were made.')
    process.exit(0)
  }

  const backupBranch = await createBackupBranch(currentBranch)

  console.log(`\nCreated backup branch: ${backupBranch}`)

  const proceed = await confirmAction(
    `Are you sure you want to rewrite history? This will modify ${commitsToRewrite.length} commit(s).`
  )

  if (!proceed) {
    cancel('Operation cancelled')
    process.exit(0)
  }

  try {
    await performRebase(commitsToRewrite, file, false)
    console.log('\nRebase completed successfully.')

    const removeBackup = await confirmAction(
      `Remove backup branch ${backupBranch}?`
    )

    if (removeBackup) {
      await $`git branch -D ${backupBranch}`
      console.log(`Backup branch ${backupBranch} removed.`)
    }

    console.log('\nCompressing git storage...')
    await runGitGc()
    console.log('Git storage compressed.')

    if (hasRemote) {
      console.warn(`\n${ICONS.warning} Remember to force-push your changes:`)
      console.warn(`  git push --force-with-lease origin ${currentBranch}`)
    }

    outro('Done! Private data has been removed from git history.')
  } catch (error) {
    console.error(`\n${ICONS.error} Error during rebase:`, error instanceof Error ? error.message : String(error))
    console.error('\nRestoring from backup branch...')

    await $`git reset --hard ${backupBranch}`
    console.error(`Restored to backup branch: ${backupBranch}`)
    process.exit(1)
  }
}

function printUsage(): void {
  console.log(`
Git Private Data Remover

Remove accidentally committed private data from git history by rewriting specific lines in their originating commits.

Usage:
  bun run src/index.ts [options]

Options:
  -f, --file <path>     File containing private data (required)
  -l, --lines <spec>    Line number(s) to remove (required, can be specified multiple times)
                        Format: "10" for single line, "10-20" for range
  -d, --dry-run         Show what would be changed without modifying history
  -h, --help            Show this help message

Examples:
  bun run src/index.ts -f config.json -l 15
  bun run src/index.ts -f .env -l 5 -l 10-15 --dry-run
`)
}

main().catch(error => {
  console.error('Unexpected error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})

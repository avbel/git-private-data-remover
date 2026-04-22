import { confirm, intro, isCancel, outro, cancel, text } from '@clack/prompts'
import chalk from 'chalk'
import { getTerminalInfo } from './terminal.ts'
import type { LineInfo } from './types.ts'

const { supportsUnicode: unicodeEnabled } = getTerminalInfo()

const ICONS = {
  success: unicodeEnabled ? '✓' : '[OK]',
  error: unicodeEnabled ? '✗' : '[ERR]',
  warning: unicodeEnabled ? '⚠' : '[WARN]',
  info: unicodeEnabled ? 'ℹ' : '[INFO]',
}

export { outro, cancel, ICONS }

export async function showIntro(): Promise<void> {
  intro(
    `${chalk.bold.blue('Git Private Data Remover')}
${chalk.gray('Remove accidentally committed private data from git history')}`
  )
}

export async function confirmAction(message: string): Promise<boolean> {
  const result = await confirm({ message, initialValue: false })
  return result === true
}

export async function confirmCommit(
  commitHash: string,
  commitSubject: string,
  lines: LineInfo[],
): Promise<boolean> {
  console.log()
  console.log(chalk.bold.blue(`${ICONS.info} Commit ${commitHash.slice(0, 8)}: ${commitSubject}`))
  console.log()

  for (const line of lines) {
    console.log(chalk.gray(`  Line ${line.originalLineNumber}: ${line.content.slice(0, 80)}`))
  }

  console.log()

  const modifyCommit = await confirm({
    message: 'These lines to replace?',
    initialValue: true,
  })

  return modifyCommit === true
}

export async function promptForReplacements(
  allLines: LineInfo[],
): Promise<Map<number, string>> {
  const replacements = new Map<number, string>()

  for (const line of allLines) {
    console.log()
    console.log(chalk.bold.blue(`${ICONS.info} Line ${line.lineNumber}:`))
    console.log(chalk.gray(`  Current: ${line.content}`))
    console.log(chalk.gray(`  Commit: ${line.commitHash.slice(0, 8)}`))

    const replacement = await promptMultiline(line.lineNumber)

    if (replacement === null) {
      throw new Error('Replacement cancelled by user')
    }

    replacements.set(line.lineNumber, replacement)
  }

  return replacements
}

async function promptMultiline(lineNumber: number): Promise<string | null> {
  const lines: string[] = []

  while (true) {
    const promptMessage =
      lines.length === 0
        ? `Enter replacement for line ${lineNumber} (empty line to finish):`
        : `Continue line ${lineNumber} (empty line to finish):`

    const answer = await text({
      message: promptMessage,
      placeholder: '',
    })

    if (isCancel(answer)) {
      return null
    }

    if (answer === '') {
      break
    }

    lines.push(answer)
  }

  if (lines.length === 0) {
    console.log(chalk.yellow(`${ICONS.warning} No replacement entered, skipping line ${lineNumber}`))
    return ''
  }

  return lines.join('\n')
}

export async function confirmDryRun(): Promise<boolean> {
  const dryRun = await confirm({
    message: 'Run in dry-run mode (no changes will be made)?',
    initialValue: true,
  })

  return dryRun === true
}

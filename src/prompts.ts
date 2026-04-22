import * as p from '@clack/prompts'
import type { LineInfo } from './types.ts'
import { supportsUnicode } from './terminal.ts'

const ICONS = {
  intro: supportsUnicode() ? '🔒' : '',
  line: supportsUnicode() ? '📝' : '',
  success: supportsUnicode() ? '✅' : '',
  warning: supportsUnicode() ? '⚠️' : '',
  error: supportsUnicode() ? '❌' : '',
  info: supportsUnicode() ? 'ℹ️' : '',
  question: supportsUnicode() ? '❓' : '',
}

export async function promptForReplacements(lines: LineInfo[]): Promise<Map<number, string>> {
  const replacements = new Map<number, string>()

  p.intro(`${ICONS.intro} Git Private Data Remover`)

  for (const line of lines) {
    const replacement = await p.text({
      message: `${ICONS.line} Line ${line.lineNumber} (commit ${line.commitHash.substring(0, 7)}):\n  Current: ${line.content}\n  Enter replacement text (or press Enter to keep):`,
      initialValue: '',
      validate(value) {
        if (value === line.content) {
          return 'Replacement cannot be the same as the original content'
        }
      },
    })

    if (p.isCancel(replacement)) {
      p.cancel('Operation cancelled')
      process.exit(0)
    }

    if (replacement && replacement.trim() !== '') {
      replacements.set(line.lineNumber, replacement)
    }
  }

  return replacements
}

export async function confirmAction(message: string): Promise<boolean> {
  const confirmed = await p.confirm({
    message,
    initialValue: false,
  })

  if (p.isCancel(confirmed)) {
    p.cancel('Operation cancelled')
    process.exit(0)
  }

  return confirmed
}

export async function confirmDryRun(): Promise<boolean> {
  return confirmAction(`${ICONS.question} Run in dry-run mode? (show plan without modifying history)`)
}

export function outro(message: string): void {
  p.outro(message)
}

export function cancel(message: string): void {
  p.cancel(message)
}

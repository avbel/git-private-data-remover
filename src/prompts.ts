import { confirm, isCancel, outro, cancel, text } from '@clack/prompts';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import { getTerminalInfo } from './terminal.ts';
import type { LineInfo } from './types.ts';

const { supportsUnicode: unicodeEnabled } = getTerminalInfo();

const ICONS = {
  success: logSymbols.success,
  error: logSymbols.error,
  warning: logSymbols.warning,
  info: logSymbols.info,
};

export { outro, cancel, ICONS };

export async function confirmAction(message: string, initialValue = false): Promise<boolean> {
  const result = await confirm({ message, initialValue });
  return result === true;
}

export async function confirmCommit(commitHash: string, commitSubject: string, lines: LineInfo[]): Promise<boolean> {
  console.log();
  console.log(chalk.bold.blue(`${ICONS.info} Commit ${commitHash.slice(0, 8)}: ${commitSubject}`));
  console.log();

  const ellipsis = unicodeEnabled ? '…' : '...';
  for (const line of lines) {
    const display = line.content.length > 80 ? `${line.content.slice(0, 80)}${ellipsis}` : line.content;
    console.log(chalk.gray(`  Line ${line.originalLineNumber}: ${display}`));
  }

  console.log();

  const modifyCommit = await confirm({
    message: 'Replace these lines?',
    initialValue: true,
  });

  return modifyCommit === true;
}

export async function promptForReplacements(allLines: LineInfo[]): Promise<Map<number, string>> {
  const replacements = new Map<number, string>();

  for (const line of allLines) {
    console.log();
    console.log(chalk.bold.blue(`${ICONS.info} Line ${line.lineNumber}:`));
    console.log(chalk.gray(`  Current: ${line.content}`));
    console.log(chalk.gray(`  Commit: ${line.commitHash.slice(0, 8)}`));

    const replacement = await promptSingleLine(line.lineNumber);

    if (replacement === null) {
      throw new Error('Replacement cancelled by user');
    }

    replacements.set(line.lineNumber, replacement);
  }

  return replacements;
}

export async function warnMultiCommitRemoval(commitCount: number): Promise<boolean> {
  console.log();
  console.log(
    chalk.yellow(`${ICONS.warning} This file was modified in ${commitCount} commits. Removing it may cause conflicts.`),
  );
  const result = await confirm({
    message: 'Continue with file removal?',
    initialValue: false,
  });
  return result === true;
}

async function promptSingleLine(lineNumber: number): Promise<string | null> {
  while (true) {
    const answer = await text({
      message: `Enter replacement for line ${lineNumber}:`,
      placeholder: '',
    });

    if (isCancel(answer)) {
      return null;
    }

    if (typeof answer !== 'string') {
      return null;
    }

    if (answer.includes('\n') || answer.includes('\r')) {
      console.log(
        chalk.yellow(
          `${ICONS.warning} Multi-line replacements are not supported; line count must stay the same. Please try again.`,
        ),
      );
      continue;
    }

    return answer;
  }
}

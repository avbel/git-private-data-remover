import process from 'node:process';
import { describeHistoryPlan, isHistoryFixupAvailable, performHistoryFixup } from './history.ts';
import { performRebase } from './rebase.ts';
import type { CommitReplacements, RewriteEngine } from './types.ts';

export const ENGINE_ENV_VAR = 'GIT_PRIVATE_DATA_REMOVER_ENGINE';

export interface EngineChoice {
  engine: RewriteEngine;
  reason: string;
}

function readEngineOverride(): RewriteEngine | undefined {
  const value = process.env[ENGINE_ENV_VAR]?.trim().toLowerCase();

  if (!value || value === 'auto') {
    return undefined;
  }

  if (value === 'history' || value === 'rebase') {
    return value;
  }

  throw new Error(`${ENGINE_ENV_VAR} must be "history", "rebase" or "auto", got "${value}"`);
}

// A target commit whose blame path differs from the HEAD path means the file was
// renamed in between. `git history fixup` relies on merge rename detection to
// carry the change back, which aborts once the rename also involved heavy edits,
// while the rebase engine edits the originating path directly. Route those runs
// to rebase up front rather than retrying, since a genuine content conflict
// would fail in rebase too.
export async function chooseEngine(commits: CommitReplacements[], headFile: string): Promise<EngineChoice> {
  const override = readEngineOverride();
  const available = await isHistoryFixupAvailable();

  if (override === 'history' && !available) {
    throw new Error(`${ENGINE_ENV_VAR}=history requires Git 2.55 or newer with the experimental "git history fixup"`);
  }

  if (override) {
    return { engine: override, reason: `forced by ${ENGINE_ENV_VAR}` };
  }

  if (!available) {
    return { engine: 'rebase', reason: '"git history fixup" is not available (needs Git 2.55+)' };
  }

  const renamed = commits.some((commit) => (commit.file ?? headFile) !== headFile);

  if (renamed) {
    return { engine: 'rebase', reason: 'the file was renamed after one of the target commits' };
  }

  return { engine: 'history', reason: 'Git supports "git history fixup"' };
}

export function describeEngine(engine: RewriteEngine): string {
  return engine === 'history' ? 'git history fixup' : 'git rebase -i';
}

export async function rewriteCommits(
  commits: CommitReplacements[],
  headFile: string,
  choice: EngineChoice,
  dryRun: boolean,
): Promise<void> {
  if (choice.engine === 'rebase') {
    await performRebase(commits, headFile, dryRun);
    return;
  }

  if (dryRun) {
    console.log('\n[DRY RUN] Rewrite plan:');
    console.log(describeHistoryPlan(commits));
    return;
  }

  await performHistoryFixup(commits, headFile);
}

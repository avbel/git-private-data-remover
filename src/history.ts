import { applyLineEdits, readBlob, stageFileContent } from './blob.ts';
import { describeError, git } from './shell.ts';
import type { CommitReplacements } from './types.ts';

// `git history` (Git 2.54+) is experimental; `fixup` arrived in 2.55. Probe the
// help text for every flag we rely on instead of trusting the version number,
// because the interface may still change and `-h` exits 0 on some builds.
const REQUIRED_FIXUP_FLAGS = ['--update-refs', '--empty'];

export async function isHistoryFixupAvailable(): Promise<boolean> {
  const help = await git(['history', 'fixup', '-h'], { nothrow: true });
  const text = `${help.stdout}\n${help.stderr}`;
  return text.includes('git history fixup') && REQUIRED_FIXUP_FLAGS.every((flag) => text.includes(flag));
}

// Applies each commit's replacements with `git history fixup`, newest commit
// first: rewriting a commit changes the hashes of its descendants but never of
// its ancestors, so the older target hashes stay valid for later rounds.
//
// `--update-refs=head` is load-bearing. The default (`branches`) also moves every
// local branch that descends from the target, which would silently rewrite the
// backup branch and destroy the restore path.
//
// `--empty=keep` keeps a target that becomes empty instead of dropping it (and
// dropping a root commit is unsupported anyway).
export async function performHistoryFixup(commits: CommitReplacements[], headFile: string): Promise<void> {
  const newestFirst = [...commits].reverse();

  for (const commit of newestFirst) {
    const content = await readBlob('HEAD', headFile);
    const edits = commit.lines.map((line) => ({ ...line, lineNumber: line.headLineNumber }));
    await stageFileContent('HEAD', headFile, applyLineEdits(content, edits, `${headFile} at HEAD`));

    try {
      await git(['history', 'fixup', commit.commitHash, '--update-refs=head', '--empty=keep'], {
        env: { GIT_EDITOR: 'true' },
      });
    } catch (error) {
      await git(['restore', '--staged', '--worktree', '--source=HEAD', '--', headFile], { nothrow: true });
      throw new Error(`git history fixup failed for ${commit.commitHash.slice(0, 8)}: ${describeError(error)}`);
    }
  }
}

export function describeHistoryPlan(commits: CommitReplacements[]): string {
  return [...commits]
    .reverse()
    .map((commit) => `git history fixup ${commit.commitHash} --update-refs=head --empty=keep`)
    .join('\n');
}

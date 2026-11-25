import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { finalizeRewrite, type FinalizeDecisions } from '../../src/finalize.ts';
import { createBackupBranch, findCommitsContainingLines, getIndexFlag, listStashCommits } from '../../src/git-utils.ts';
import { isHistoryFixupAvailable, performHistoryFixup } from '../../src/history.ts';
import { assertLineRewriteInvariant, assertRemovalInvariant } from '../../src/invariant.ts';
import { performFileRemoval, performRebase } from '../../src/rebase.ts';
import { planFileRemoval } from '../../src/removal.ts';
import { restoreWorkingCopy, snapshotWorkingCopy } from '../../src/remove-mode.ts';
import { collectPathBlobs, findBlobsContaining, findReachableBlobs } from '../../src/scan.ts';
import type { CommitReplacements } from '../../src/types.ts';
import { commit, git, gitResult, planFor, rejectsWith, showBytes, useTempRepo, writeText } from '../helpers.ts';

const historyAvailable = await isHistoryFixupAvailable();
const skipWithoutHistory = historyAvailable ? false : 'git history fixup is not available (needs Git 2.55+)';

type Engine = (commits: CommitReplacements[], file: string) => Promise<void>;

const engines: Array<[string, Engine, false | string]> = [
  ['rebase', (commits, file) => performRebase(commits, file, false), false],
  ['history', (commits, file) => performHistoryFixup(commits, file), skipWithoutHistory],
];

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

function decisions(removeBackup: boolean, purgeStorage: boolean): FinalizeDecisions {
  return { removeBackup: async () => removeBackup, purgeStorage: async () => purgeStorage };
}

for (const [name, engine, skip] of engines) {
  describe(`byte-exact rewrites (${name} engine)`, { skip }, () => {
    useTempRepo();

    it('keeps the untouched bytes of a non-UTF-8 file', async () => {
      await commit('legacy.txt', latin1('caf\xe9 comment\nAPI_KEY=secret123\nna\xefve\n'), 'leak');
      await commit('legacy.txt', latin1('caf\xe9 comment\nAPI_KEY=secret123\nna\xefve\n\ntail\n'), 'more');

      await engine(await planFor('legacy.txt', 2, 'API_KEY=REDACTED'), 'legacy.txt');

      assert.deepEqual(await showBytes('HEAD~1:legacy.txt'), latin1('caf\xe9 comment\nAPI_KEY=REDACTED\nna\xefve\n'));
      assert.deepEqual(
        await showBytes('HEAD:legacy.txt'),
        latin1('caf\xe9 comment\nAPI_KEY=REDACTED\nna\xefve\n\ntail\n'),
      );
      assert.deepEqual(readFileSync('legacy.txt'), latin1('caf\xe9 comment\nAPI_KEY=REDACTED\nna\xefve\n\ntail\n'));
    });

    it('rewrites CRLF files and keeps their line endings', async () => {
      await commit('win.env', 'A=1\r\nTOKEN=secret\r\nB=2\r\n', 'leak');
      await commit('win.env', 'A=1\r\nTOKEN=secret\r\nB=2\r\n\r\nC=3\r\n', 'more');

      await engine(await planFor('win.env', 2, 'TOKEN=REDACTED'), 'win.env');

      assert.equal((await showBytes('HEAD~1:win.env')).toString(), 'A=1\r\nTOKEN=REDACTED\r\nB=2\r\n');
      assert.equal((await showBytes('HEAD:win.env')).toString(), 'A=1\r\nTOKEN=REDACTED\r\nB=2\r\n\r\nC=3\r\n');
    });

    it('is not affected by core.autocrlf on an LF repository', async () => {
      await commit('app.env', 'A=1\nTOKEN=secret\nB=2\n', 'leak');
      await commit('app.env', 'A=1\nTOKEN=secret\nB=2\n\nC=3\n', 'more');
      await git('config', 'core.autocrlf', 'true');

      await engine(await planFor('app.env', 2, 'TOKEN=REDACTED'), 'app.env');

      assert.equal((await showBytes('HEAD:app.env')).toString(), 'A=1\nTOKEN=REDACTED\nB=2\n\nC=3\n');
      assert.equal(await git('status', '--porcelain'), '');
    });
  });
}

describe('rewrite invariant', () => {
  useTempRepo();

  it('passes for a correct rewrite and fails when untargeted content changed', async () => {
    await commit('f.txt', 'a\nSECRET=1\nb\n', 'leak');
    await commit('f.txt', 'a\nSECRET=1\nb\n\nc\n', 'more');
    const plan = await planFor('f.txt', 2, 'SECRET=x');
    const backup = await createBackupBranch('main');
    const expectation = {
      backupRef: backup,
      base: undefined,
      allowedPaths: ['f.txt'],
      headFile: 'f.txt',
      headLines: [2],
    };

    await performRebase(plan, 'f.txt', false);
    await assertLineRewriteInvariant(expectation);

    await commit('f.txt', 'a\nSECRET=x\nb\n\nchanged\n', 'simulated engine damage');
    await git('reset', '--soft', 'HEAD~1');
    await git('commit', '-q', '--amend', '--no-edit');
    await rejectsWith(assertLineRewriteInvariant(expectation), 'changed outside the targeted lines');
  });

  it('fails a removal that touched another path', async () => {
    await commit('secret.pem', 'key\n', 'leak');
    await commit('keep.txt', 'keep\n', 'other');
    const backup = await createBackupBranch('main');
    await git('rm', '-q', 'secret.pem', 'keep.txt');
    await git('commit', '-q', '-m', 'simulated over-removal');

    await rejectsWith(assertRemovalInvariant(backup, ['secret.pem']), 'keep.txt');
  });
});

describe('finalizeRewrite', () => {
  useTempRepo();

  async function rewrittenRepo(): Promise<{ backup: string; plan: CommitReplacements[] }> {
    await commit('f.txt', 'SECRET=hunter2\nkeep\n', 'leak');
    await commit('g.txt', 'g\n', 'next');
    const plan = await planFor('f.txt', 1, 'SECRET=x');
    const backup = await createBackupBranch('main');
    await performRebase(plan, 'f.txt', false);
    return { backup, plan };
  }

  const exactLines = (plan: CommitReplacements[]) => (tips: readonly string[]) =>
    findCommitsContainingLines(
      ['f.txt'],
      plan.flatMap((c) => c.lines.map((l) => l.originalContent)),
      tips,
    );

  it('verifies while the backup exists and ignores the backup itself', async () => {
    const { backup, plan } = await rewrittenRepo();

    const result = await finalizeRewrite(backup, exactLines(plan), decisions(false, false));

    assert.deepEqual(result, { clean: true, backupKept: true, purged: false });
    assert.equal((await gitResult('rev-parse', '--verify', backup)).exitCode, 0);
  });

  it('keeps the backup and skips the purge when leftovers exist', async () => {
    const { backup, plan } = await rewrittenRepo();
    await git('branch', 'old-copy', backup);
    let asked = false;
    const spy: FinalizeDecisions = {
      removeBackup: async () => {
        asked = true;
        return true;
      },
      purgeStorage: async () => true,
    };

    const result = await finalizeRewrite(backup, exactLines(plan), spy);

    assert.deepEqual(result, { clean: false, backupKept: true, purged: false, remoteOnly: false });
    assert.equal(asked, false);
    assert.equal((await gitResult('rev-parse', '--verify', backup)).exitCode, 0);
  });

  it('leaves stashes alone when the purge is declined', async () => {
    const { backup, plan } = await rewrittenRepo();
    await writeText('g.txt', 'stash one\n');
    await git('stash', 'push', '-q');
    await writeText('g.txt', 'stash two\n');
    await git('stash', 'push', '-q');

    const result = await finalizeRewrite(backup, exactLines(plan), decisions(true, false));

    assert.deepEqual(result, { clean: true, backupKept: false, purged: false });
    assert.equal((await listStashCommits()).length, 2);
  });

  it('purges only after the backup is deleted and the user agrees', async () => {
    const { backup, plan } = await rewrittenRepo();

    const result = await finalizeRewrite(backup, exactLines(plan), decisions(true, true));

    assert.deepEqual(result, { clean: true, backupKept: false, purged: true });
    assert.equal((await git('reflog', 'show', '--format=%H', 'main')).trim(), '');
  });

  it('recognises leftovers held only by remote-tracking refs (already pushed)', async () => {
    await git('init', '-q', '--bare', 'remote.git');
    await git('remote', 'add', 'origin', 'remote.git');
    await commit('f.txt', 'SECRET=hunter2\nkeep\n', 'leak');
    await commit('g.txt', 'g\n', 'next');
    await git('push', '-q', '-u', 'origin', 'main');
    const plan = await planFor('f.txt', 1, 'SECRET=x');
    const backup = await createBackupBranch('main');
    await performRebase(plan, 'f.txt', false);

    const result = await finalizeRewrite(backup, exactLines(plan), decisions(true, true));

    assert.deepEqual(result, { clean: false, backupKept: true, purged: false, remoteOnly: true });
    assert.equal((await gitResult('rev-parse', '--verify', backup)).exitCode, 0);
  });

  it('finds the secret in a stash entry that is not the newest', async () => {
    const { backup, plan } = await rewrittenRepo();
    await writeText('f.txt', 'SECRET=hunter2\nkeep\nlocal\n');
    await git('stash', 'push', '-q');
    await writeText('g.txt', 'newer stash\n');
    await git('stash', 'push', '-q');

    const result = await finalizeRewrite(backup, exactLines(plan), decisions(true, true));

    assert.equal(result.clean, false);
  });
});

describe('removed-value scan', () => {
  useTempRepo();

  it('finds the secret in an older commit that formatted the line differently, in any file', async () => {
    await commit('cfg.txt', 'API_KEY=secret123\n', 'first version');
    await commit('cfg.txt', 'API_KEY = "secret123"\n', 'reformat');
    const plan = await planFor('cfg.txt', 1, 'API_KEY = "REDACTED"');
    const backup = await createBackupBranch('main');
    await performRebase(plan, 'cfg.txt', false);
    const tips = [`--exclude=refs/heads/${backup}`, '--all'];

    assert.deepEqual(await findCommitsContainingLines(['cfg.txt'], ['API_KEY = "secret123"'], tips), []);
    const hits = await findBlobsContaining(['secret123'], tips);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.commits.includes((await git('rev-parse', 'HEAD~1')).trim()), true);
  });
});

describe('--rm safety', () => {
  useTempRepo();

  it('removes every earlier name of a renamed file', async () => {
    await commit('secrets.txt', 'DB_PASSWORD=hunter2\n', 'add');
    await git('mv', 'secrets.txt', '.env');
    await git('commit', '-q', '-m', 'rename');
    await commit('other.txt', 'other\n', 'other');
    const plan = await planFileRemoval('.env');
    const blobs = await collectPathBlobs(plan.paths);

    assert.deepEqual(plan.paths, ['.env', 'secrets.txt']);

    const backup = await createBackupBranch('main');
    await performFileRemoval(plan.paths, 'main');
    await assertRemovalInvariant(backup, plan.paths);

    const tips = [`--exclude=refs/heads/${backup}`, '--all'];
    assert.deepEqual(await findReachableBlobs(blobs, tips), []);
    assert.equal(
      (await git('log', '--exclude=refs/heads/backup/*', '--all', '--format=%H', '--', 'secrets.txt')).trim(),
      '',
    );
    assert.equal(await git('show', 'HEAD:other.txt'), 'other\n');
  });

  it('refuses when an earlier name was later reused by an unrelated file', async () => {
    await commit('secrets.txt', 'DB_PASSWORD=hunter2\n', 'add');
    await git('mv', 'secrets.txt', '.env');
    await git('commit', '-q', '-m', 'rename');
    await commit('secrets.txt', 'unrelated notes\n', 'new unrelated file');

    await rejectsWith(planFileRemoval('.env'), 'also used by another file');
  });

  it('reports blobs of the removed file still reachable from another branch', async () => {
    await commit('key.pem', 'PRIVATE\n', 'add key');
    await git('branch', 'feature');
    const blobs = await collectPathBlobs(['key.pem']);
    const backup = await createBackupBranch('main');
    await performFileRemoval(['key.pem'], 'main');

    const hits = await findReachableBlobs(blobs, [`--exclude=refs/heads/${backup}`, '--all']);
    assert.equal(hits.length, 1);
  });

  it('treats file names as literal paths, not globs', async () => {
    await commit('a*.txt', 'secret\n', 'odd name');
    await commit('abc.txt', 'innocent\n', 'innocent');

    await performFileRemoval(['a*.txt'], 'main');

    assert.equal(await git('show', 'HEAD:abc.txt'), 'innocent\n');
    assert.equal((await gitResult('cat-file', '-e', 'HEAD:a*.txt')).exitCode, 128);
  });

  it('keeps the working copy as an untracked file', async () => {
    await commit('.env', 'TOKEN=only-copy\n', 'add');
    await commit('other.txt', 'o\n', 'other');
    const copy = snapshotWorkingCopy('.env');

    await performFileRemoval(['.env'], 'main');
    assert.equal(existsSync('.env'), false);
    restoreWorkingCopy('.env', copy);

    assert.equal(readFileSync('.env', 'utf8'), 'TOKEN=only-copy\n');
    assert.equal(await git('status', '--porcelain', '--', '.env'), '?? .env\n');
  });
});

describe('index flags', () => {
  useTempRepo();

  it('detects skip-worktree and assume-unchanged paths', async () => {
    await commit('a.txt', 'a\n', 'a');
    await commit('b.txt', 'b\n', 'b');
    await commit('c.txt', 'c\n', 'c');
    await git('update-index', '--skip-worktree', 'a.txt');
    await git('update-index', '--assume-unchanged', 'b.txt');

    assert.equal(await getIndexFlag('a.txt'), 'skip-worktree');
    assert.equal(await getIndexFlag('b.txt'), 'assume-unchanged');
    assert.equal(await getIndexFlag('c.txt'), undefined);
  });
});

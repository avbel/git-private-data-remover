import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { getLineBlameInfo, groupReplacementsByCommit, isGitRepoClean } from '../../src/git-utils.ts';
import { isHistoryFixupAvailable, performHistoryFixup } from '../../src/history.ts';
import { performRebase } from '../../src/rebase.ts';
import { chooseEngine, ENGINE_ENV_VAR } from '../../src/rewrite.ts';
import type { CommitReplacements } from '../../src/types.ts';
import { git, initRepo, rejectsWith, writeText } from '../helpers.ts';

const historyAvailable = await isHistoryFixupAvailable();
const skipWithoutHistory = historyAvailable ? false : 'git history fixup is not available (needs Git 2.55+)';

function useTempRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): void {
  let originalCwd = '';
  let tempDir = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-private-data-remover-')));
    process.chdir(tempDir);
    await initRepo(objectFormat);
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

async function commit(file: string, content: string, message: string): Promise<string> {
  await writeText(file, content);
  await git('add', '--', file);
  await git('commit', '-q', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

async function planFor(file: string, line: number, replacement: string): Promise<CommitReplacements[]> {
  const info = await getLineBlameInfo(file, { start: line, end: line });
  return groupReplacementsByCommit(info, new Map([[line, replacement]]));
}

describe('performHistoryFixup', { skip: skipWithoutHistory }, () => {
  useTempRepo();

  it('rewrites the originating commit and leaves other branches, other commits and local files alone', async () => {
    const base = await commit('app.env', 'A=1\nB=2\n', 'base');
    await commit('app.env', 'A=1\nTOKEN=secret\nB=2\n', 'add token');
    await commit('other.txt', 'other\n', 'other file');
    await commit('app.env', 'A=1\nTOKEN=secret\nB=2\nC=3\n', 'add C');
    await git('branch', 'backup');
    const backupBefore = (await git('rev-parse', 'backup')).trim();
    await writeText('untracked.txt', 'local only\n');

    await performHistoryFixup(await planFor('app.env', 2, 'TOKEN=REDACTED'), 'app.env');

    assert.equal((await git('rev-parse', 'backup')).trim(), backupBefore);
    assert.equal(await git('show', `${base}:app.env`), 'A=1\nB=2\n');
    assert.equal(await git('show', 'HEAD~2:app.env'), 'A=1\nTOKEN=REDACTED\nB=2\n');
    assert.equal(await git('show', 'HEAD:app.env'), 'A=1\nTOKEN=REDACTED\nB=2\nC=3\n');
    assert.equal(await git('show', 'HEAD~1:other.txt'), 'other\n');
    assert.deepEqual((await git('log', '--format=%s')).trim().split('\n'), [
      'add C',
      'other file',
      'add token',
      'base',
    ]);
    assert.equal(await isGitRepoClean(), true);
    assert.equal(await git('status', '--porcelain'), '?? untracked.txt\n');
  });

  it('rewrites several originating commits, including the root commit', async () => {
    await commit('cfg.txt', 'ROOT_SECRET=1\nkeep\n', 'root');
    await commit('cfg.txt', 'ROOT_SECRET=1\nkeep\nLATER_SECRET=2\ngap\n', 'later');
    await commit('cfg.txt', 'ROOT_SECRET=1\nkeep\nLATER_SECRET=2\ngap\ntail\n', 'tail');

    const info = [
      ...(await getLineBlameInfo('cfg.txt', { start: 1, end: 1 })),
      ...(await getLineBlameInfo('cfg.txt', { start: 3, end: 3 })),
    ];
    const plan = await groupReplacementsByCommit(
      info,
      new Map([
        [1, 'ROOT_SECRET=x'],
        [3, 'LATER_SECRET=x'],
      ]),
    );
    assert.equal(plan.length, 2);

    await performHistoryFixup(plan, 'cfg.txt');

    assert.equal(await git('show', 'HEAD~2:cfg.txt'), 'ROOT_SECRET=x\nkeep\n');
    assert.equal(await git('show', 'HEAD~1:cfg.txt'), 'ROOT_SECRET=x\nkeep\nLATER_SECRET=x\ngap\n');
    assert.equal(await git('show', 'HEAD:cfg.txt'), 'ROOT_SECRET=x\nkeep\nLATER_SECRET=x\ngap\ntail\n');
    assert.equal((await git('rev-list', '--count', 'HEAD')).trim(), '3');
  });

  it('keeps a target commit that becomes empty', async () => {
    await commit('f.txt', 'value=public\n', 'base');
    await commit('f.txt', 'value=secret\n', 'leak');
    await commit('g.txt', 'g\n', 'next');

    await performHistoryFixup(await planFor('f.txt', 1, 'value=public'), 'f.txt');

    assert.deepEqual((await git('log', '--format=%s')).trim().split('\n'), ['next', 'leak', 'base']);
    assert.equal(await git('show', 'HEAD:f.txt'), 'value=public\n');
  });

  it('refuses when HEAD no longer has the line blame reported and leaves the repository untouched', async () => {
    await commit('f.txt', 'SECRET=1\n', 'leak');
    const head = (await git('rev-parse', 'HEAD')).trim();
    const plan = await planFor('f.txt', 1, 'SECRET=x');
    const stale = plan.map((c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, originalContent: 'other' })) }));

    await rejectsWith(performHistoryFixup(stale, 'f.txt'), 'Content mismatch');

    assert.equal((await git('rev-parse', 'HEAD')).trim(), head);
    assert.equal(await isGitRepoClean(), true);
  });

  it('aborts atomically on a conflict and restores the index and working tree', async () => {
    await commit('f.txt', 'a\nSECRET=1\nb\n', 'leak');
    await commit('f.txt', 'a\nSECRET=1\nB-changed\n', 'touch adjacent line');
    const head = (await git('rev-parse', 'HEAD')).trim();
    const plan = await planFor('f.txt', 2, 'SECRET=x');

    await rejectsWith(performHistoryFixup(plan, 'f.txt'), 'git history fixup failed');

    assert.equal((await git('rev-parse', 'HEAD')).trim(), head);
    assert.equal(await git('status', '--porcelain'), '');
  });
});

describe('performRebase empty commits', () => {
  useTempRepo();

  it('keeps a target commit that becomes empty, like the history engine', async () => {
    await commit('f.txt', 'value=public\n', 'base');
    await commit('f.txt', 'value=secret\n', 'leak');
    await commit('g.txt', 'g\n', 'next');

    await performRebase(await planFor('f.txt', 1, 'value=public'), 'f.txt', false);

    assert.deepEqual((await git('log', '--format=%s')).trim().split('\n'), ['next', 'leak', 'base']);
    assert.equal(await git('show', 'HEAD:f.txt'), 'value=public\n');
  });
});

describe('SHA-256 repositories', () => {
  useTempRepo('sha256');

  it('parses 64-character blame hashes', async () => {
    const hash = await commit('s.txt', 'SECRET=1\na\nb\n', 'leak');
    const info = await getLineBlameInfo('s.txt', { start: 1, end: 1 });

    assert.equal(info.length, 1);
    assert.equal(info[0].commitHash, hash);
    assert.match(info[0].commitHash, /^[a-f0-9]{64}$/);
    assert.equal(info[0].content, 'SECRET=1');
  });

  it('rewrites history with the rebase engine', async () => {
    await commit('s.txt', 'SECRET=1\na\nb\n', 'leak');
    await commit('s.txt', 'SECRET=1\na\nb\nc\n', 'more');

    await performRebase(await planFor('s.txt', 1, 'SECRET=x'), 's.txt', false);

    assert.equal(await git('show', 'HEAD~1:s.txt'), 'SECRET=x\na\nb\n');
    assert.equal(await git('show', 'HEAD:s.txt'), 'SECRET=x\na\nb\nc\n');
  });

  it('rewrites history with the git history engine', { skip: skipWithoutHistory }, async () => {
    await commit('s.txt', 'SECRET=1\na\nb\n', 'leak');
    await commit('s.txt', 'SECRET=1\na\nb\nc\n', 'more');

    await performHistoryFixup(await planFor('s.txt', 1, 'SECRET=x'), 's.txt');

    assert.equal(await git('show', 'HEAD~1:s.txt'), 'SECRET=x\na\nb\n');
    assert.equal(await git('show', 'HEAD:s.txt'), 'SECRET=x\na\nb\nc\n');
  });
});

describe('chooseEngine', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENGINE_ENV_VAR];
    delete process.env[ENGINE_ENV_VAR];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENGINE_ENV_VAR];
    } else {
      process.env[ENGINE_ENV_VAR] = saved;
    }
  });

  const plan = (file: string): CommitReplacements[] => [{ commitHash: 'a'.repeat(40), file, lines: [] }];

  it('prefers git history when available and the path is unchanged', async () => {
    const choice = await chooseEngine(plan('f.txt'), 'f.txt');
    assert.equal(choice.engine, historyAvailable ? 'history' : 'rebase');
  });

  it('falls back to rebase when the file was renamed after a target commit', async () => {
    const choice = await chooseEngine(plan('old.txt'), 'new.txt');
    assert.equal(choice.engine, 'rebase');
  });

  it('honours an explicit rebase override', async () => {
    process.env[ENGINE_ENV_VAR] = 'rebase';
    assert.equal((await chooseEngine(plan('f.txt'), 'f.txt')).engine, 'rebase');
  });

  it('rejects an unknown override', async () => {
    process.env[ENGINE_ENV_VAR] = 'filter-branch';
    await rejectsWith(chooseEngine(plan('f.txt'), 'f.txt'), ENGINE_ENV_VAR);
  });
});

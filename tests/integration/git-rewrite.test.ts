import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLineSpecs } from '../../src/parser.ts';
import {
  checkGitVersion,
  findCommitsContainingLines,
  getCommitsTouchingFile,
  getCurrentBranch,
  getLineBlameInfo,
  getRefsContaining,
  groupReplacementsByCommit,
  purgeReflogAndGc,
} from '../../src/git-utils.ts';
import { performRebase, performFileRemoval } from '../../src/rebase.ts';
import type { CommitReplacements } from '../../src/types.ts';
import { excludes, git, gitResult, includes, initRepo, rejectsWith, writeText as writeFile } from '../helpers.ts';

// process.execPath is the runtime executing this test (node or bun), so each
// runtime exercises the CLI under itself.
function spawnCli(args: string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['src/index.ts', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.once('error', reject);
    proc.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe('Git integration tests', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'));
    process.chdir(tempDir);

    await initRepo();
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects git version', async () => {
    await assert.doesNotReject(checkGitVersion('1.0.0'));
    await rejectsWith(checkGitVersion('99.99.99'));
  });

  it('gets blame info for single line', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\n');
    await git('add', 'test.txt');
    await git('commit', '-m', 'Initial commit');

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('test.txt', ranges[0]);

    assert.equal(info.length, 1);
    assert.equal(info[0].content, 'line2');
    assert.equal(info[0].lineNumber, 2);
    assert.match(info[0].commitHash, /^[a-f0-9]{40}$/);
  });

  it('gets blame info for range', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await git('add', 'test.txt');
    await git('commit', '-m', 'Initial commit');

    const ranges = parseLineSpecs('2-4');
    const info = await getLineBlameInfo('test.txt', ranges[0]);

    assert.equal(info.length, 3);
    assert.equal(info[0].content, 'line2');
    assert.equal(info[1].content, 'line3');
    assert.equal(info[2].content, 'line4');
  });

  it('groups replacements by commit', async () => {
    await writeFile('test.txt', 'line1\nSECRET_KEY=abc123\nline3\n');
    await git('add', 'test.txt');
    await git('commit', '-m', 'Initial commit');

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('test.txt', ranges[0]);
    const replacements = new Map([[2, 'SECRET_KEY=REDACTED']]);

    const grouped = await groupReplacementsByCommit(info, replacements);

    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].lines.length, 1);
    assert.equal(grouped[0].lines[0].originalContent, 'SECRET_KEY=abc123');
    assert.equal(grouped[0].lines[0].replacementContent, 'SECRET_KEY=REDACTED');
  });

  it('handles multiple files in same commit', async () => {
    await writeFile('file1.txt', 'content1\n');
    await writeFile('file2.txt', 'content2\n');
    await git('add', 'file1.txt', 'file2.txt');
    await git('commit', '-m', 'Add two files');

    const ranges = parseLineSpecs('1');
    const info = await getLineBlameInfo('file1.txt', ranges[0]);

    assert.equal(info.length, 1);
    assert.equal(info[0].content, 'content1');
  });

  it('handles multiple commits', async () => {
    await writeFile('test.txt', 'line1\nline2\n');
    await git('add', 'test.txt');
    await git('commit', '-m', 'First commit');

    await writeFile('test.txt', 'line1\nline2\nline3\n');
    await git('add', 'test.txt');
    await git('commit', '-m', 'Second commit');

    const ranges = parseLineSpecs('1,3');
    const info1 = await getLineBlameInfo('test.txt', ranges[0]);
    const info3 = await getLineBlameInfo('test.txt', ranges[1]);

    assert.notEqual(info1[0].commitHash, info3[0].commitHash);
  });

  it('performRebase rewrites history', async () => {
    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');

    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\nMORE=data\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add more data');

    const ranges = parseLineSpecs('1');
    const info = await getLineBlameInfo('secret.txt', ranges[0]);
    const replacements = new Map([[1, 'SECRET=REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    assert.equal(commits.length, 1);

    await performRebase(commits, 'secret.txt', false);

    const blame = await getLineBlameInfo('secret.txt', ranges[0]);
    assert.equal(blame[0].content, 'SECRET=REDACTED');

    const log = await git('log', '--oneline');
    includes(log, 'Add secret');
    includes(log, 'Add more data');
  });

  it('rewrites middle commit when private data is not in first commit', async () => {
    await writeFile('data.txt', 'safe1\nsafe2\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Add safe data');

    await writeFile('data.txt', 'safe1\nSECRET=abc\nsafe2\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Add secret');

    await writeFile('data.txt', 'safe1\nSECRET=abc\nsafe2\nsafe3\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Add more data');

    const logBefore = await git('log', '--reverse', '--format=%H');
    const allCommits = logBefore.trim().split('\n');
    assert.equal(allCommits.length, 3);

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('data.txt', ranges[0]);
    const replacements = new Map([[2, 'REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    assert.equal(commits.length, 1);
    assert.equal(commits[0].commitHash, allCommits[1]);
    assert.notEqual(commits[0].commitHash, allCommits[0]);

    await performRebase(commits, 'data.txt', false);

    const commit1Content = await git('show', `${allCommits[0]}:data.txt`);
    assert.equal(commit1Content, 'safe1\nsafe2\n');

    const commit2Content = await git('show', 'HEAD~1:data.txt');
    assert.equal(commit2Content, 'safe1\nREDACTED\nsafe2\n');

    const headContent = await git('show', 'HEAD:data.txt');
    assert.equal(headContent, 'safe1\nREDACTED\nsafe2\nsafe3\n');

    const newLog = await git('log', '--oneline');
    assert.equal(newLog.split('\n').filter(Boolean).length, 3);
  });

  it('only modifies target commit when file changes in several commits', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Initial file');

    lines[4] = 'SECRET=123';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Add secret to line 5');

    lines[9] = 'modified-line10';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Modify line 10');

    lines[8] = 'modified-line9';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Modify line 9');

    const logBefore = await git('log', '--reverse', '--format=%H');
    const allCommits = logBefore.trim().split('\n');

    const ranges = parseLineSpecs('5');
    const info = await getLineBlameInfo('multi.txt', ranges[0]);
    const replacements = new Map([[5, 'REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    assert.equal(commits.length, 1);
    assert.equal(commits[0].commitHash, allCommits[1]);

    await performRebase(commits, 'multi.txt', false);

    const commit1Content = await git('show', `${allCommits[0]}:multi.txt`);
    assert.equal(commit1Content, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');

    const commit2Content = await git('show', 'HEAD~2:multi.txt');
    const expectedCommit2 =
      Array.from({ length: 10 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    assert.equal(commit2Content, expectedCommit2);

    const commit3Content = await git('show', 'HEAD~1:multi.txt');
    const expectedCommit3 =
      Array.from({ length: 10 }, (_, i) => {
        if (i === 4) return 'REDACTED';
        if (i === 9) return 'modified-line10';
        return `line${i + 1}`;
      }).join('\n') + '\n';
    assert.equal(commit3Content, expectedCommit3);

    const headContent = await git('show', 'HEAD:multi.txt');
    const expectedHead =
      Array.from({ length: 10 }, (_, i) => {
        if (i === 4) return 'REDACTED';
        if (i === 8) return 'modified-line9';
        if (i === 9) return 'modified-line10';
        return `line${i + 1}`;
      }).join('\n') + '\n';
    assert.equal(headContent, expectedHead);

    const newLog = await git('log', '--oneline');
    assert.equal(newLog.split('\n').filter(Boolean).length, 4);
  });

  it('edits only adding commit when private data was later removed', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile('data.txt', lines.join('\n') + '\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Initial file');

    lines[4] = 'API_KEY=secret123';
    await writeFile('data.txt', lines.join('\n') + '\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Add secret');

    lines.pop();
    await writeFile('data.txt', lines.join('\n') + '\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Remove last line');

    const logBefore = await git('log', '--reverse', '--format=%H');
    const allCommits = logBefore.trim().split('\n');
    assert.equal(allCommits.length, 3);

    const commitWithSecret = allCommits[1];

    const commitGroup = {
      commitHash: commitWithSecret,
      commitSubject: 'Add secret',
      lines: [
        {
          lineNumber: 5,
          headLineNumber: 5,
          originalContent: 'API_KEY=secret123',
          replacementContent: 'REDACTED',
        },
      ],
    };

    await performRebase([commitGroup], 'data.txt', false);

    const commit1Content = await git('show', `${allCommits[0]}:data.txt`);
    assert.equal(commit1Content, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');

    const commit2Content = await git('show', 'HEAD~1:data.txt');
    const expectedCommit2 =
      Array.from({ length: 10 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    assert.equal(commit2Content, expectedCommit2);

    const headContent = await git('show', 'HEAD:data.txt');
    const expectedHead = Array.from({ length: 9 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    assert.equal(headContent, expectedHead);

    const allCommitHashes = (await git('rev-list', '--all')).trim().split('\n');
    for (const commit of allCommitHashes) {
      const showResult = await gitResult('show', `${commit}:data.txt`);
      if (showResult.exitCode === 0) {
        excludes(showResult.stdout, 'API_KEY=secret123');
      }
    }
  });

  it('rolls back cleanly when the secret line was modified again in a later commit (rebase conflict)', async () => {
    const file = 'config.txt';
    const filePath = join(tempDir, file);

    const lines1 = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    await writeFile(filePath, lines1.join('\n'));
    await git('add', file);
    await git('commit', '-m', 'Initial commit');

    const lines2 = [...lines1];
    lines2[4] = 'SECRET=first_value';
    await writeFile(filePath, lines2.join('\n'));
    await git('add', file);
    await git('commit', '-m', 'Add secret');

    const lines3 = [...lines2];
    lines3[4] = 'SECRET=second_value';
    await writeFile(filePath, lines3.join('\n'));
    await git('add', file);
    await git('commit', '-m', 'Change secret value');

    const lines4 = [...lines3];
    lines4[4] = 'SECRET=third_value';
    await writeFile(filePath, lines4.join('\n'));
    await git('add', file);
    await git('commit', '-m', 'Change secret again');

    const lines5 = [...lines4];
    lines5.splice(4, 1);
    await writeFile(filePath, lines5.join('\n'));
    await git('add', file);
    await git('commit', '-m', 'Remove secret');

    const logOutput = await git('log', '--reverse', '--format=%H');
    const [, c2] = logOutput.trim().split('\n');

    await git('branch', 'backup-before-rebase');

    const commitGroup: CommitReplacements[] = [
      {
        commitHash: c2,
        lines: [
          {
            lineNumber: 5,
            headLineNumber: 5,
            originalContent: 'SECRET=first_value',
            replacementContent: '',
          },
        ],
      },
    ];

    let rebaseFailed = false;
    try {
      await performRebase(commitGroup, file, false);

      const gitDir = await git('rev-parse', '--git-dir');
      const rebaseMergeDir = join(tempDir, gitDir.trim(), 'rebase-merge');
      const rebaseApplyDir = join(tempDir, gitDir.trim(), 'rebase-apply');

      if (existsSync(rebaseMergeDir) || existsSync(rebaseApplyDir)) {
        rebaseFailed = true;
        await git('rebase', '--abort');
      }
    } catch {
      rebaseFailed = true;
      try {
        await git('rebase', '--abort');
      } catch {
        // rebase may not be in progress
      }
    }

    await git('reset', '--hard', 'backup-before-rebase');

    const originalLog = await git('log', '--oneline');
    includes(originalLog, 'Initial commit');
    includes(originalLog, 'Add secret');
    includes(originalLog, 'Change secret value');
    includes(originalLog, 'Change secret again');
    includes(originalLog, 'Remove secret');

    const status = await git('status', '--porcelain');
    assert.equal(status, '');

    assert.equal(rebaseFailed, true);
  });

  it('supports multiline replacement content', async () => {
    await writeFile('config.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await git('add', 'config.txt');
    await git('commit', '-m', 'Initial commit');

    await writeFile('config.txt', 'line1\nline2\nSECRET=top_secret\nline4\nline5\n');
    await git('add', 'config.txt');
    await git('commit', '-m', 'Add secret');

    const logOutput = await git('log', '--reverse', '--format=%H');
    const [, c2] = logOutput.trim().split('\n');

    const commitGroup: CommitReplacements[] = [
      {
        commitHash: c2,
        lines: [
          {
            lineNumber: 3,
            headLineNumber: 3,
            originalContent: 'SECRET=top_secret',
            replacementContent: 'REDACTED_LINE_1\nREDACTED_LINE_2\nREDACTED_LINE_3',
          },
        ],
      },
    ];

    await performRebase(commitGroup, 'config.txt', false);

    const finalContent = await git('show', 'HEAD:config.txt');
    assert.equal(finalContent, 'line1\nline2\nREDACTED_LINE_1\nREDACTED_LINE_2\nREDACTED_LINE_3\nline4\nline5\n');

    const log = await git('log', '--oneline');
    includes(log, 'Initial commit');
    includes(log, 'Add secret');
    excludes(log, 'SECRET=top_secret');

    const blameOutput = await git('blame', 'config.txt');
    excludes(blameOutput, 'SECRET=top_secret');
  });

  it('performFileRemoval removes file from single commit', { timeout: 30000 }, async () => {
    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');

    await writeFile('other.txt', 'other-data\n');
    await git('add', 'other.txt');
    await git('commit', '-m', 'Add other file');

    const commitsBefore = await getCommitsTouchingFile('secret.txt');
    assert.equal(commitsBefore.length, 1);

    await performFileRemoval('secret.txt', await getCurrentBranch());

    const commitsAfter = await getCommitsTouchingFile('secret.txt');
    assert.equal(commitsAfter.length, 0);

    const log = await git('log', '--oneline');
    includes(log, 'Add other file');
  });

  it('performFileRemoval removes file modified in multiple commits', { timeout: 30000 }, async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Initial file');

    lines[4] = 'SECRET=123';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Add secret to line 5');

    lines[9] = 'modified-line10';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await git('add', 'multi.txt');
    await git('commit', '-m', 'Modify line 10');

    await writeFile('other.txt', 'other-data\n');
    await git('add', 'other.txt');
    await git('commit', '-m', 'Add other file');

    const commitsBefore = await getCommitsTouchingFile('multi.txt');
    assert.equal(commitsBefore.length, 3);

    await performFileRemoval('multi.txt', await getCurrentBranch());

    const commitsAfter = await getCommitsTouchingFile('multi.txt');
    assert.equal(commitsAfter.length, 0);

    const otherContent = await git('show', 'HEAD:other.txt');
    assert.equal(otherContent, 'other-data\n');
  });

  it('performFileRemoval does not remove pre-existing branches', { timeout: 30000 }, async () => {
    await writeFile('data.txt', 'sensitive-data\n');
    await git('add', 'data.txt');
    await git('commit', '-m', 'Add data');

    await git('branch', 'backup-before-removal');

    await performFileRemoval('data.txt', await getCurrentBranch());

    const branchList = await git('branch');
    includes(branchList, 'backup-before-removal');

    const backupContent = await git('show', 'backup-before-removal:data.txt');
    assert.equal(backupContent, 'sensitive-data\n');
  });

  it('rewrites a line whose originating commit stored the file under a different name', async () => {
    await writeFile('old-name.txt', 'SECRET=abc\nkeep\n');
    await git('add', 'old-name.txt');
    await git('commit', '-m', 'Add secret under old name');

    await git('mv', 'old-name.txt', 'new-name.txt');
    await git('commit', '-m', 'Rename file');

    const info = await getLineBlameInfo('new-name.txt', { start: 1, end: 1 });
    assert.equal(info[0].originalFile, 'old-name.txt');

    const commits = await groupReplacementsByCommit(info, new Map([[1, 'SECRET=REDACTED']]));
    assert.equal(commits[0].file, 'old-name.txt');

    await performRebase(commits, 'new-name.txt', false);

    const firstCommit = (await git('rev-list', '--max-parents=0', 'HEAD')).trim();
    assert.equal(await git('show', `${firstCommit}:old-name.txt`), 'SECRET=REDACTED\nkeep\n');
    assert.equal(await git('show', 'HEAD:new-name.txt'), 'SECRET=REDACTED\nkeep\n');
  });

  it('reports commits that still contain the original line via another ref after a rewrite', {
    timeout: 30000,
  }, async () => {
    await writeFile('secret.txt', 'SECRET=old-value\nkeep\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');
    await git('branch', 'keep-old-history');

    const info = await getLineBlameInfo('secret.txt', { start: 1, end: 1 });
    const commits = await groupReplacementsByCommit(info, new Map([[1, 'SECRET=REDACTED']]));
    await performRebase(commits, 'secret.txt', false);

    assert.equal(await git('show', 'HEAD:secret.txt'), 'SECRET=REDACTED\nkeep\n');

    const hits = await findCommitsContainingLines(['secret.txt'], ['SECRET=old-value']);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].lines, ['SECRET=old-value']);
    assert.deepEqual(await getRefsContaining(hits[0].hash), ['refs/heads/keep-old-history']);

    await git('branch', '-D', 'keep-old-history');
    await purgeReflogAndGc();
    assert.deepEqual(await findCommitsContainingLines(['secret.txt'], ['SECRET=old-value']), []);
  });
});

describe('Working directory flag', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts --help with working directory', async () => {
    const { exitCode, stdout } = await spawnCli(['-w', tempDir, '--help'], projectRoot);

    assert.equal(exitCode, 0);
    includes(stdout, 'Git Private Data Remover');
  });

  it('fails with non-existent working directory', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');

    const { exitCode, stderr } = await spawnCli(['-w', nonExistentDir, '-f', 'file.txt', '-l', '1'], projectRoot);

    assert.equal(exitCode, 1);
    includes(stderr, 'Working directory not found');
  });

  it('operates in specified working directory', async () => {
    process.chdir(tempDir);
    await initRepo();
    await writeFile('secret.txt', 'SECRET=old\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');
    await writeFile('secret.txt', 'modified\n');
    process.chdir(projectRoot);

    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-f', 'secret.txt', '-l', '1'], projectRoot);

    assert.equal(exitCode, 1);
    includes(stderr, 'Git repository has uncommitted changes');
  });
});

describe('--rm CLI flag', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'));
    process.chdir(tempDir);

    await initRepo();
  });

  afterEach(() => {
    try {
      process.chdir(projectRoot);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('errors when --rm and --lines are both provided', async () => {
    await writeFile('secret.txt', 'SECRET=old\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');

    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-f', 'secret.txt', '-r', '-l', '1'], projectRoot);

    assert.equal(exitCode, 1);
    includes(stderr, 'mutually exclusive');
  });

  it('dry-run shows commits without modifying history', async () => {
    await writeFile('secret.txt', 'SECRET=old\n');
    await git('add', 'secret.txt');
    await git('commit', '-m', 'Add secret');

    await writeFile('other.txt', 'other\n');
    await git('add', 'other.txt');
    await git('commit', '-m', 'Add other');

    const { exitCode, stdout } = await spawnCli(['-w', tempDir, '-f', 'secret.txt', '-r', '-d'], projectRoot);

    assert.equal(exitCode, 0);
    includes(stdout, 'DRY RUN');
    includes(stdout, 'Add secret');

    const commits = await getCommitsTouchingFile('secret.txt');
    assert.equal(commits.length, 1);
  });

  it('requires --file when using --rm', async () => {
    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-r'], projectRoot);

    assert.equal(exitCode, 1);
    includes(stderr, '--file');
  });

  it('resolves the file relative to the repository root when -w points at a subdirectory', async () => {
    mkdirSync('sub');
    await writeFile('sub/secret.txt', 'SECRET=old\n');
    await git('add', 'sub/secret.txt');
    await git('commit', '-m', 'Add nested secret');

    const { exitCode, stdout } = await spawnCli(
      ['-w', join(tempDir, 'sub'), '-f', './secret.txt', '-r', '-d'],
      projectRoot,
    );

    assert.equal(exitCode, 0);
    includes(stdout, 'Checking file: sub/secret.txt');
    includes(stdout, 'File found in 1 commit(s)');
  });

  it('rejects a file outside the repository', async () => {
    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-f', '../outside.txt', '-r'], projectRoot);

    assert.equal(exitCode, 1);
    includes(stderr, 'outside the repository');
  });
});

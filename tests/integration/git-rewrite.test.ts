import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLineSpecs } from '../../src/parser.ts';
import { checkGitVersion, getLineBlameInfo, groupReplacementsByCommit } from '../../src/git-utils.ts';
import { performRebase } from '../../src/rebase.ts';
import type { CommitReplacements } from '../../src/types.ts';

async function spawnCli(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stdout));
  const stderr = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stderr));

  return { exitCode, stdout, stderr };
}

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

describe('Git integration tests', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'));
    process.chdir(tempDir);

    await $`git init`;
    await $`git config user.email "test@example.com"`;
    await $`git config user.name "Test User"`;
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects git version', async () => {
    await expect(checkGitVersion('1.0.0')).resolves.toBeUndefined();
    await expect(checkGitVersion('99.99.99')).rejects.toThrow();
  });

  it('gets blame info for single line', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\n');
    await $`git add test.txt`;
    await $`git commit -m "Initial commit"`;

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('test.txt', ranges[0]);

    expect(info).toHaveLength(1);
    expect(info[0].content).toBe('line2');
    expect(info[0].lineNumber).toBe(2);
    expect(info[0].commitHash).toMatch(/^[a-f0-9]{40}$/);
  });

  it('gets blame info for range', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await $`git add test.txt`;
    await $`git commit -m "Initial commit"`;

    const ranges = parseLineSpecs('2-4');
    const info = await getLineBlameInfo('test.txt', ranges[0]);

    expect(info).toHaveLength(3);
    expect(info[0].content).toBe('line2');
    expect(info[1].content).toBe('line3');
    expect(info[2].content).toBe('line4');
  });

  it('groups replacements by commit', async () => {
    await writeFile('test.txt', 'line1\nSECRET_KEY=abc123\nline3\n');
    await $`git add test.txt`;
    await $`git commit -m "Initial commit"`;

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('test.txt', ranges[0]);
    const replacements = new Map([[2, 'SECRET_KEY=REDACTED']]);

    const grouped = await groupReplacementsByCommit(info, replacements);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].lines).toHaveLength(1);
    expect(grouped[0].lines[0].originalContent).toBe('SECRET_KEY=abc123');
    expect(grouped[0].lines[0].replacementContent).toBe('SECRET_KEY=REDACTED');
  });

  it('handles multiple files in same commit', async () => {
    await writeFile('file1.txt', 'content1\n');
    await writeFile('file2.txt', 'content2\n');
    await $`git add file1.txt file2.txt`;
    await $`git commit -m "Add two files"`;

    const ranges = parseLineSpecs('1');
    const info = await getLineBlameInfo('file1.txt', ranges[0]);

    expect(info).toHaveLength(1);
    expect(info[0].content).toBe('content1');
  });

  it('handles multiple commits', async () => {
    await writeFile('test.txt', 'line1\nline2\n');
    await $`git add test.txt`;
    await $`git commit -m "First commit"`;

    await writeFile('test.txt', 'line1\nline2\nline3\n');
    await $`git add test.txt`;
    await $`git commit -m "Second commit"`;

    const ranges = parseLineSpecs('1,3');
    const info1 = await getLineBlameInfo('test.txt', ranges[0]);
    const info3 = await getLineBlameInfo('test.txt', ranges[1]);

    expect(info1[0].commitHash).not.toBe(info3[0].commitHash);
  });

  it('performRebase rewrites history', async () => {
    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\n');
    await $`git add secret.txt`;
    await $`git commit -m "Add secret"`;

    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\nMORE=data\n');
    await $`git add secret.txt`;
    await $`git commit -m "Add more data"`;

    const ranges = parseLineSpecs('1');
    const info = await getLineBlameInfo('secret.txt', ranges[0]);
    const replacements = new Map([[1, 'SECRET=REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    expect(commits).toHaveLength(1);

    await performRebase(commits, 'secret.txt', false);

    const blame = await getLineBlameInfo('secret.txt', ranges[0]);
    expect(blame[0].content).toBe('SECRET=REDACTED');

    const log = await $`git log --oneline`.text();
    expect(log).toContain('Add secret');
    expect(log).toContain('Add more data');
  });

  it('rewrites middle commit when private data is not in first commit', async () => {
    await writeFile('data.txt', 'safe1\nsafe2\n');
    await $`git add data.txt`;
    await $`git commit -m "Add safe data"`;

    await writeFile('data.txt', 'safe1\nSECRET=abc\nsafe2\n');
    await $`git add data.txt`;
    await $`git commit -m "Add secret"`;

    await writeFile('data.txt', 'safe1\nSECRET=abc\nsafe2\nsafe3\n');
    await $`git add data.txt`;
    await $`git commit -m "Add more data"`;

    const logBefore = await $`git log --reverse --format=%H`.text();
    const allCommits = logBefore.trim().split('\n');
    expect(allCommits).toHaveLength(3);

    const ranges = parseLineSpecs('2');
    const info = await getLineBlameInfo('data.txt', ranges[0]);
    const replacements = new Map([[2, 'REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    expect(commits).toHaveLength(1);
    expect(commits[0].commitHash).toBe(allCommits[1]);
    expect(commits[0].commitHash).not.toBe(allCommits[0]);

    await performRebase(commits, 'data.txt', false);

    const commit1Content = await $`git show ${allCommits[0]}:data.txt`.text();
    expect(commit1Content).toBe('safe1\nsafe2\n');

    const commit2Content = await $`git show HEAD~1:data.txt`.text();
    expect(commit2Content).toBe('safe1\nREDACTED\nsafe2\n');

    const headContent = await $`git show HEAD:data.txt`.text();
    expect(headContent).toBe('safe1\nREDACTED\nsafe2\nsafe3\n');

    const newLog = await $`git log --oneline`.text();
    expect(newLog.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('only modifies target commit when file changes in several commits', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await $`git add multi.txt`;
    await $`git commit -m "Initial file"`;

    lines[4] = 'SECRET=123';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await $`git add multi.txt`;
    await $`git commit -m "Add secret to line 5"`;

    lines[9] = 'modified-line10';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await $`git add multi.txt`;
    await $`git commit -m "Modify line 10"`;

    lines[8] = 'modified-line9';
    await writeFile('multi.txt', lines.join('\n') + '\n');
    await $`git add multi.txt`;
    await $`git commit -m "Modify line 9"`;

    const logBefore = await $`git log --reverse --format=%H`.text();
    const allCommits = logBefore.trim().split('\n');

    const ranges = parseLineSpecs('5');
    const info = await getLineBlameInfo('multi.txt', ranges[0]);
    const replacements = new Map([[5, 'REDACTED']]);
    const commits = await groupReplacementsByCommit(info, replacements);

    expect(commits).toHaveLength(1);
    expect(commits[0].commitHash).toBe(allCommits[1]);

    await performRebase(commits, 'multi.txt', false);

    const commit1Content = await $`git show ${allCommits[0]}:multi.txt`.text();
    expect(commit1Content).toBe(Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');

    const commit2Content = await $`git show HEAD~2:multi.txt`.text();
    const expectedCommit2 =
      Array.from({ length: 10 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    expect(commit2Content).toBe(expectedCommit2);

    const commit3Content = await $`git show HEAD~1:multi.txt`.text();
    const expectedCommit3 =
      Array.from({ length: 10 }, (_, i) => {
        if (i === 4) return 'REDACTED';
        if (i === 9) return 'modified-line10';
        return `line${i + 1}`;
      }).join('\n') + '\n';
    expect(commit3Content).toBe(expectedCommit3);

    const headContent = await $`git show HEAD:multi.txt`.text();
    const expectedHead =
      Array.from({ length: 10 }, (_, i) => {
        if (i === 4) return 'REDACTED';
        if (i === 8) return 'modified-line9';
        if (i === 9) return 'modified-line10';
        return `line${i + 1}`;
      }).join('\n') + '\n';
    expect(headContent).toBe(expectedHead);

    const newLog = await $`git log --oneline`.text();
    expect(newLog.split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('edits only adding commit when private data was later removed', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile('data.txt', lines.join('\n') + '\n');
    await $`git add data.txt`;
    await $`git commit -m "Initial file"`;

    lines[4] = 'API_KEY=secret123';
    await writeFile('data.txt', lines.join('\n') + '\n');
    await $`git add data.txt`;
    await $`git commit -m "Add secret"`;

    lines.pop();
    await writeFile('data.txt', lines.join('\n') + '\n');
    await $`git add data.txt`;
    await $`git commit -m "Remove last line"`;

    const logBefore = await $`git log --reverse --format=%H`.text();
    const allCommits = logBefore.trim().split('\n');
    expect(allCommits).toHaveLength(3);

    const commitWithSecret = allCommits[1];

    const commitGroup = {
      commitHash: commitWithSecret,
      commitSubject: 'Add secret',
      lines: [
        {
          lineNumber: 5,
          originalContent: 'API_KEY=secret123',
          replacementContent: 'REDACTED',
        },
      ],
    };

    await performRebase([commitGroup], 'data.txt', false);

    const commit1Content = await $`git show ${allCommits[0]}:data.txt`.text();
    expect(commit1Content).toBe(Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n');

    const commit2Content = await $`git show HEAD~1:data.txt`.text();
    const expectedCommit2 =
      Array.from({ length: 10 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    expect(commit2Content).toBe(expectedCommit2);

    const headContent = await $`git show HEAD:data.txt`.text();
    const expectedHead = Array.from({ length: 9 }, (_, i) => (i === 4 ? 'REDACTED' : `line${i + 1}`)).join('\n') + '\n';
    expect(headContent).toBe(expectedHead);

    const allCommitHashes = (await $`git rev-list --all`.text()).trim().split('\n');
    for (const commit of allCommitHashes) {
      const showResult = await $`git show ${commit}:data.txt`.nothrow();
      if (showResult.exitCode === 0) {
        expect(showResult.text()).not.toContain('API_KEY=secret123');
      }
    }
  });

  it('handles private data that was modified and removed in later commits (empty replacement)', async () => {
    const file = 'config.txt';
    const filePath = join(tempDir, file);

    const lines1 = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    await Bun.write(filePath, lines1.join('\n'));
    await $`git add ${file}`;
    await $`git commit -m "Initial commit"`;

    const lines2 = [...lines1];
    lines2[4] = 'SECRET=first_value';
    await Bun.write(filePath, lines2.join('\n'));
    await $`git add ${file}`;
    await $`git commit -m "Add secret"`;

    const lines3 = [...lines2];
    lines3[4] = 'SECRET=second_value';
    await Bun.write(filePath, lines3.join('\n'));
    await $`git add ${file}`;
    await $`git commit -m "Change secret value"`;

    const lines4 = [...lines3];
    lines4[4] = 'SECRET=third_value';
    await Bun.write(filePath, lines4.join('\n'));
    await $`git add ${file}`;
    await $`git commit -m "Change secret again"`;

    const lines5 = [...lines4];
    lines5.splice(4, 1);
    await Bun.write(filePath, lines5.join('\n'));
    await $`git add ${file}`;
    await $`git commit -m "Remove secret"`;

    const logOutput = await $`git log --reverse --format=%H`.text();
    const [, c2] = logOutput.trim().split('\n');

    await $`git branch backup-before-rebase`;

    const commitGroup: CommitReplacements[] = [
      {
        commitHash: c2,
        lines: [
          {
            lineNumber: 5,
            originalContent: 'SECRET=first_value',
            replacementContent: '',
          },
        ],
      },
    ];

    let rebaseFailed = false;
    try {
      await performRebase(commitGroup, file, false);

      const gitDir = await $`git rev-parse --git-dir`.text();
      const rebaseMergeDir = join(tempDir, gitDir.trim(), 'rebase-merge');
      const rebaseApplyDir = join(tempDir, gitDir.trim(), 'rebase-apply');

      if (existsSync(rebaseMergeDir) || existsSync(rebaseApplyDir)) {
        rebaseFailed = true;
        await $`git rebase --abort`.quiet();
      }
    } catch {
      rebaseFailed = true;
      try {
        await $`git rebase --abort`.quiet();
      } catch {
        // rebase may not be in progress
      }
    }

    await $`git reset --hard backup-before-rebase`;

    const originalLog = await $`git log --oneline`.text();
    expect(originalLog).toContain('Initial commit');
    expect(originalLog).toContain('Add secret');
    expect(originalLog).toContain('Change secret value');
    expect(originalLog).toContain('Change secret again');
    expect(originalLog).toContain('Remove secret');

    const status = await $`git status --porcelain`.text();
    expect(status).toBe('');

    expect(rebaseFailed).toBe(true);
  });

  it('supports multiline replacement content', async () => {
    process.chdir(tempDir);
    await $`git init`;
    await $`git config user.email "test@example.com"`;
    await $`git config user.name "Test User"`;

    await writeFile('config.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await $`git add config.txt`;
    await $`git commit -m "Initial commit"`;

    await writeFile('config.txt', 'line1\nline2\nSECRET=top_secret\nline4\nline5\n');
    await $`git add config.txt`;
    await $`git commit -m "Add secret"`;

    const logOutput = await $`git log --reverse --format=%H`.text();
    const [, c2] = logOutput.trim().split('\n');

    const commitGroup: CommitReplacements[] = [
      {
        commitHash: c2,
        lines: [
          {
            lineNumber: 3,
            originalContent: 'SECRET=top_secret',
            replacementContent: 'REDACTED_LINE_1\nREDACTED_LINE_2\nREDACTED_LINE_3',
          },
        ],
      },
    ];

    await performRebase(commitGroup, 'config.txt', false);

    const finalContent = await $`git show HEAD:config.txt`.text();
    expect(finalContent).toBe('line1\nline2\nREDACTED_LINE_1\nREDACTED_LINE_2\nREDACTED_LINE_3\nline4\nline5\n');

    const log = await $`git log --oneline`.text();
    expect(log).toContain('Initial commit');
    expect(log).toContain('Add secret');
    expect(log).not.toContain('SECRET=top_secret');

    const blameOutput = await $`git blame config.txt`.text();
    expect(blameOutput).not.toContain('SECRET=top_secret');
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

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Git Private Data Remover');
  });

  it('fails with non-existent working directory', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist');

    const { exitCode, stderr } = await spawnCli(['-w', nonExistentDir, '-f', 'file.txt', '-l', '1'], projectRoot);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Working directory not found');
  });

  it('operates in specified working directory', async () => {
    process.chdir(tempDir);
    await $`git init`;
    await $`git config user.email "test@example.com"`;
    await $`git config user.name "Test User"`;
    await writeFile('secret.txt', 'SECRET=old\n');
    await $`git add secret.txt`;
    await $`git commit -m "Add secret"`;
    await writeFile('secret.txt', 'modified\n');
    process.chdir(projectRoot);

    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-f', 'secret.txt', '-l', '1'], projectRoot);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Git repository has uncommitted changes');
  });
});

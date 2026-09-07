import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { $ } from 'bun';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupeLineInfos, getCommitsTouchingFile, resolveRepoFile } from '../../src/git-utils.ts';
import type { LineInfo } from '../../src/types.ts';

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

describe('getCommitsTouchingFile', () => {
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

  it('returns commit hash for file in single commit', async () => {
    await writeFile('file.txt', 'content\n');
    await $`git add file.txt`;
    await $`git commit -m "Add file"`;

    const commits = await getCommitsTouchingFile('file.txt');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatch(/^[a-f0-9]{40}$/);
  });

  it('returns all commits that touch the file', async () => {
    await writeFile('file.txt', 'initial\n');
    await $`git add file.txt`;
    await $`git commit -m "Initial commit"`;

    await writeFile('file.txt', 'modified\n');
    await $`git add file.txt`;
    await $`git commit -m "Modify file"`;

    await writeFile('other.txt', 'other\n');
    await $`git add other.txt`;
    await $`git commit -m "Add other file"`;

    const commits = await getCommitsTouchingFile('file.txt');
    expect(commits).toHaveLength(2);
    for (const hash of commits) {
      expect(hash).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it('returns empty array for untracked file', async () => {
    await writeFile('untracked.txt', 'content\n');

    const commits = await getCommitsTouchingFile('untracked.txt');
    expect(commits).toEqual([]);
  });

  it('returns empty array for file not in history', async () => {
    const commits = await getCommitsTouchingFile('nonexistent.txt');
    expect(commits).toEqual([]);
  });

  it('follows file renames', async () => {
    await writeFile('old-name.txt', 'content\n');
    await $`git add old-name.txt`;
    await $`git commit -m "Add file"`;

    await $`git mv old-name.txt new-name.txt`;
    await $`git commit -m "Rename file"`;

    const commits = await getCommitsTouchingFile('new-name.txt');
    expect(commits).toHaveLength(2);
  });
});

describe('resolveRepoFile', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-private-data-remover-')));
    process.chdir(tempDir);

    await $`git init`;
    await $`git config user.email "test@example.com"`;
    await $`git config user.name "Test User"`;

    mkdirSync('sub');
    await writeFile('sub/tracked.txt', 'content\n');
    await $`git add sub/tracked.txt`;
    await $`git commit -m "Add nested file"`;
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns the repository root and a root-relative path from the root', async () => {
    const result = await resolveRepoFile('sub/tracked.txt');
    expect(result).toEqual({ toplevel: tempDir, relativePath: 'sub/tracked.txt', tracked: true });
  });

  it('resolves paths relative to a subdirectory and normalizes ./ prefixes', async () => {
    process.chdir(join(tempDir, 'sub'));
    const result = await resolveRepoFile('./tracked.txt');
    expect(result).toEqual({ toplevel: tempDir, relativePath: 'sub/tracked.txt', tracked: true });
  });

  it('reports untracked files as not tracked', async () => {
    await writeFile('sub/untracked.txt', 'content\n');
    const result = await resolveRepoFile('sub/untracked.txt');
    expect(result.tracked).toBe(false);
    expect(result.relativePath).toBe('sub/untracked.txt');
  });

  it('rejects files outside the repository', async () => {
    await expect(resolveRepoFile('../outside.txt')).rejects.toThrow('outside the repository');
  });
});

describe('dedupeLineInfos', () => {
  const makeLine = (lineNumber: number, commitHash = 'a'.repeat(40)): LineInfo => ({
    lineNumber,
    content: `line${lineNumber}`,
    commitHash,
    originalLineNumber: lineNumber,
    originalFile: 'file.txt',
  });

  it('keeps the first occurrence of each line number', () => {
    const result = dedupeLineInfos([makeLine(5), makeLine(3), makeLine(5), makeLine(4), makeLine(3)]);
    expect(result.map((line) => line.lineNumber)).toEqual([5, 3, 4]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeLineInfos([])).toEqual([]);
  });
});

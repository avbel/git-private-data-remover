import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach } from 'node:test';
import { getLineBlameInfo, groupReplacementsByCommit } from '../src/git-utils.ts';
import { git as runGit, type RunResult } from '../src/shell.ts';
import type { CommitReplacements } from '../src/types.ts';

export async function git(...args: string[]): Promise<string> {
  return (await runGit(args)).stdout;
}

export function gitResult(...args: string[]): Promise<RunResult> {
  return runGit(args, { nothrow: true });
}

export async function writeText(path: string, content: string | Buffer): Promise<void> {
  await writeFile(path, content);
}

export async function initRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<void> {
  await git('init', '-q', '--initial-branch=main', `--object-format=${objectFormat}`);
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test User');
  // Global settings such as core.autocrlf=input would normalize fixtures on add.
  await git('config', 'core.autocrlf', 'false');
}

export function includes(haystack: string | readonly string[], needle: string): void {
  assert.ok(haystack.includes(needle), `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
}

export function excludes(haystack: string | readonly string[], needle: string): void {
  assert.ok(
    !haystack.includes(needle),
    `expected ${JSON.stringify(haystack)} not to include ${JSON.stringify(needle)}`,
  );
}

export function throwsWith(fn: () => unknown, fragment: string): void {
  assert.throws(fn, (error: unknown) => error instanceof Error && error.message.includes(fragment));
}

export async function rejectsWith(promise: Promise<unknown>, fragment?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.includes(fragment ?? ''));
}

export function useTempRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): void {
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

export async function commit(file: string, content: string | Buffer, message: string): Promise<string> {
  await writeText(file, content);
  await git('add', '--', file);
  await git('commit', '-q', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

export async function planFor(file: string, line: number, replacement: string): Promise<CommitReplacements[]> {
  const info = await getLineBlameInfo(file, { start: line, end: line });
  return groupReplacementsByCommit(info, new Map([[line, replacement]]));
}

export async function showBytes(spec: string): Promise<Buffer> {
  return (await runGit(['cat-file', 'blob', spec])).stdoutBytes;
}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { git as runGit, type RunResult } from '../src/shell.ts';

export async function git(...args: string[]): Promise<string> {
  return (await runGit(args)).stdout;
}

export function gitResult(...args: string[]): Promise<RunResult> {
  return runGit(args, { nothrow: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content);
}

export async function initRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<void> {
  await git('init', '-q', `--object-format=${objectFormat}`);
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test User');
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

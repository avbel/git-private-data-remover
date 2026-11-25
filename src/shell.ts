import { spawn } from 'node:child_process';
import process from 'node:process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve with the non-zero exit code instead of throwing. */
  nothrow?: boolean;
  /** Mirror the command's output to the terminal while still capturing it. */
  echo?: boolean;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, result: RunResult) {
    super(`Command failed with exit code ${result.exitCode}: ${command}`);
    this.name = 'CommandError';
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

// Arguments go straight to execve, never through a shell, so file names and
// replacement text cannot be interpreted as shell syntax. Output is buffered
// manually because execFile's maxBuffer (1 MiB) is easily exceeded by
// `git show <commit>:<file>` or `git log --all`.
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (options.echo) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      if (options.echo) {
        process.stderr.write(chunk);
      }
    });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result: RunResult = {
        exitCode: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };

      if (result.exitCode !== 0 && !options.nothrow) {
        reject(new CommandError([command, ...args].join(' '), result));
        return;
      }

      resolve(result);
    });
  });
}

export function git(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return run('git', args, options);
}

export async function gitText(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return (await git(args, options)).stdout;
}

export function describeError(error: unknown): string {
  if (error instanceof CommandError) {
    const stderr = error.stderr.trim();
    return stderr ? `${error.message}\n${stderr}` : error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

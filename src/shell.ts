import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve with the non-zero exit code instead of throwing. */
  nothrow?: boolean;
  /** Mirror the command's output to the terminal while still capturing it. */
  echo?: boolean;
  /** Bytes written to the command's stdin. */
  input?: Buffer;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw stdout, for file content that must round-trip byte for byte. */
  stdoutBytes: Buffer;
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

// A signal sent only to this process (e.g. `kill <pid>`, unlike a terminal
// Ctrl-C) does not reach the git children. A still-running `git history fixup`,
// filter-repo or filter-branch could then move the branch again after the
// backup was restored, so the signal handler stops them first.
const running = new Set<ChildProcess>();
const CHILD_KILL_GRACE_MS = 3000;

function track<T extends ChildProcess>(child: T): T {
  running.add(child);
  child.once('close', () => running.delete(child));
  return child;
}

export async function terminateRunningCommands(): Promise<void> {
  const children = Array.from(running).filter((child) => child.exitCode === null && child.signalCode === null);

  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
}

// Every path this tool hands to git is a literal file name. Without this, a name
// containing `*`, `?` or `[` is a glob and can match (and rewrite or delete) other
// files. Exported through the environment so it also reaches the `git rm` that
// filter-branch runs from its index filter.
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, GIT_LITERAL_PATHSPECS: '1' };
}

// Arguments go straight to execve, never through a shell, so file names and
// replacement text cannot be interpreted as shell syntax. Output is buffered
// manually because execFile's maxBuffer (1 MiB) is easily exceeded by
// `git show <commit>:<file>` or `git log --all`.
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = track(
      spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );

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

    // Closing stdin straight away also stops git from ever waiting for input.
    // A command that exits without reading it raises EPIPE here; its exit code
    // already reports the failure, so the stream error carries no information.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);

    child.once('error', reject);
    child.once('close', (code, signal) => {
      const stdoutBytes = Buffer.concat(stdout);
      const result: RunResult = {
        exitCode: code ?? (signal ? 128 : 1),
        stdout: stdoutBytes.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutBytes,
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
  return run('git', args, { ...options, env: gitEnv(options.env) });
}

export async function gitText(args: readonly string[], options: RunOptions = {}): Promise<string> {
  return (await git(args, options)).stdout;
}

export function spawnGit(args: readonly string[]): ChildProcessWithoutNullStreams {
  return track(spawn('git', args, { env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] }));
}

export function describeError(error: unknown): string {
  if (error instanceof CommandError) {
    const stderr = error.stderr.trim();
    return stderr ? `${error.message}\n${stderr}` : error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

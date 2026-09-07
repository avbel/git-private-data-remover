import { $ } from 'bun';

export function describeError(error: unknown): string {
  if (error instanceof $.ShellError) {
    const stderr = error.stderr.toString().trim();
    return stderr ? `${error.message}\n${stderr}` : error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

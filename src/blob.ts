import { byteStringToBuffer, bytesToByteString, type ByteString } from './bytes.ts';
import { git } from './shell.ts';

export async function readBlob(rev: string, path: string): Promise<ByteString> {
  return bytesToByteString((await git(['cat-file', 'blob', `${rev}:${path}`])).stdoutBytes);
}

async function readMode(rev: string, path: string): Promise<string> {
  const entry = (await git(['ls-tree', rev, '--', path])).stdout;
  const mode = entry.split(' ')[0];

  if (!mode || !/^\d{6}$/.test(mode)) {
    throw new Error(`${path} is not a file at ${rev}`);
  }

  return mode;
}

// Writes the new content straight into the object store and the index, then
// checks the index entry out. Writing the working file and running `git add`
// would pass the content through clean filters (core.autocrlf, LFS, ...) and
// could rewrite every line of the file, not just the targeted ones. The checkout
// keeps index and working tree identical, so the rewrite engines see a clean
// tree afterwards.
export async function stageFileContent(rev: string, path: string, content: ByteString): Promise<void> {
  const mode = await readMode(rev, path);
  const blob = (
    await git(['hash-object', '-w', '--no-filters', '--stdin'], { input: byteStringToBuffer(content) })
  ).stdout.trim();

  await git(['update-index', '--cacheinfo', `${mode},${blob},${path}`]);
  await git(['checkout-index', '-f', '--', path]);
}

export interface LineEdit {
  lineNumber: number;
  originalContent: ByteString;
  replacementContent: ByteString;
}

export function applyLineEdits(content: ByteString, edits: readonly LineEdit[], where: string): ByteString {
  const lines = content.split('\n');

  for (const edit of edits) {
    const index = edit.lineNumber - 1;

    if (index < 0 || index >= lines.length) {
      throw new Error(`Line ${edit.lineNumber} does not exist in ${where}`);
    }

    if (lines[index] !== edit.originalContent) {
      throw new Error(
        `Content mismatch at line ${edit.lineNumber} of ${where}: the line does not match what git blame reported`,
      );
    }
  }

  const byIndex = new Map(edits.map((edit) => [edit.lineNumber - 1, edit.replacementContent]));
  return lines.map((line, index) => byIndex.get(index) ?? line).join('\n');
}

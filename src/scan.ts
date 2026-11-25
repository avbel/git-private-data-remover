import { byteStringToBuffer, type ByteString } from './bytes.ts';
import { git, spawnGit } from './shell.ts';

// The empty blob is shared by every empty file in every repository; matching on
// it would flag unrelated files.
const EMPTY_BLOB_IDS = new Set([
  'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
]);

export async function listReachableObjects(tipArgs: readonly string[]): Promise<string[]> {
  const output = await git(['rev-list', '--objects', ...tipArgs]);
  return output.stdout
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter(Boolean);
}

async function filterBlobs(objectIds: readonly string[]): Promise<string[]> {
  if (objectIds.length === 0) {
    return [];
  }

  const output = await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: Buffer.from(`${objectIds.join('\n')}\n`),
  });

  return output.stdout
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([id, type, size]) => type === 'blob' && size !== '0' && id !== undefined && !EMPTY_BLOB_IDS.has(id))
    .map(([id]) => id as string);
}

// Streams every blob through one `git cat-file --batch` and matches in-process.
// The needles are the private data itself, so they must never appear on a
// command line (`git grep -e`, `git log -S`), where any local user can read them
// from the process list for as long as the scan runs.
function scanBlobs(blobIds: readonly string[], needles: readonly Buffer[]): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const hits = new Set<string>();
    const child = spawnGit(['cat-file', '--batch']);
    let pending: Buffer = Buffer.alloc(0);
    let current: { id: string; size: number } | undefined;
    let stderr = '';

    const drain = (): void => {
      while (true) {
        if (!current) {
          const newline = pending.indexOf(0x0a);

          if (newline === -1) {
            return;
          }

          const [id, type, size] = pending.subarray(0, newline).toString('utf8').split(' ');
          pending = pending.subarray(newline + 1);

          if (type === 'missing' || size === undefined) {
            continue;
          }

          current = { id: id ?? '', size: Number.parseInt(size, 10) || 0 };
        }

        if (pending.length < current.size + 1) {
          return;
        }

        const content = pending.subarray(0, current.size);

        if (needles.some((needle) => content.includes(needle))) {
          hits.add(current.id);
        }

        pending = pending.subarray(current.size + 1);
        current = undefined;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      drain();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file --batch failed (${code}): ${stderr.trim()}`));
        return;
      }

      resolve(hits);
    });

    child.stdin.on('error', reject);
    child.stdin.end(`${blobIds.join('\n')}\n`);
  });
}

export async function commitsIntroducingObject(objectId: string, tipArgs: readonly string[]): Promise<string[]> {
  const output = await git(['log', '--format=%H', `--find-object=${objectId}`, ...tipArgs], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

export interface BlobHit {
  blob: string;
  commits: string[];
}

export async function findBlobsContaining(
  needles: readonly ByteString[],
  tipArgs: readonly string[],
): Promise<BlobHit[]> {
  const unique = Array.from(new Set(needles)).filter((needle) => needle !== '');

  if (unique.length === 0) {
    return [];
  }

  const blobs = await filterBlobs(await listReachableObjects(tipArgs));
  const matching = await scanBlobs(blobs, unique.map(byteStringToBuffer));
  const hits: BlobHit[] = [];

  for (const blob of matching) {
    hits.push({ blob, commits: await commitsIntroducingObject(blob, tipArgs) });
  }

  return hits;
}

export async function findReachableBlobs(blobIds: ReadonlySet<string>, tipArgs: readonly string[]): Promise<BlobHit[]> {
  const reachable = await listReachableObjects(tipArgs);
  const hits: BlobHit[] = [];

  for (const blob of new Set(reachable.filter((id) => blobIds.has(id) && !EMPTY_BLOB_IDS.has(id)))) {
    hits.push({ blob, commits: await commitsIntroducingObject(blob, tipArgs) });
  }

  return hits;
}

// Every blob id the given paths ever had on the current branch, recorded before
// `--rm` so that copies kept alive elsewhere (other branches, tags, stashes, or
// the same content committed under another name) are found afterwards.
export async function collectPathBlobs(paths: readonly string[]): Promise<Set<string>> {
  const output = await git(['log', '--format=', '--raw', '--no-abbrev', '--no-renames', 'HEAD', '--', ...paths]);
  const blobs = new Set<string>();

  for (const line of output.stdout.split('\n')) {
    if (!line.startsWith(':')) {
      continue;
    }

    const [, , before, after] = line.split('\t')[0]?.split(' ') ?? [];

    for (const id of [before, after]) {
      if (id && !/^0+$/.test(id)) {
        blobs.add(id);
      }
    }
  }

  return blobs;
}

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { byteStringToText, bytesToByteString, encodeReplacement } from './bytes.ts';
import { git, gitText } from './shell.ts';
import type { CommitReplacements, ContentHit, LineInfo, LineRange, RepoFile, Replacement } from './types.ts';

// SHA-1 repositories use 40 hex digits, SHA-256 repositories (`git init --object-format=sha256`) use 64.
const BLAME_HEADER = /^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)/;

export async function checkGitVersion(minVersion: string): Promise<void> {
  const versionOutput = await gitText(['--version']);
  const match = versionOutput.match(/git version (\d+)\.(\d+)\.(\d+)/);

  if (!match) {
    throw new Error('Could not detect git version. Is git installed?');
  }

  const currentVersion = `${match[1]}.${match[2]}.${match[3]}`;

  if (compareVersions(currentVersion, minVersion) < 0) {
    throw new Error(`Git version ${currentVersion} is too old. Minimum required: ${minVersion}`);
  }
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;

    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

export async function resolveRepoFile(file: string): Promise<RepoFile> {
  const toplevel = (await gitText(['rev-parse', '--show-toplevel'])).trim();
  const absolute = resolve(realpathSync(process.cwd()), file);
  const rel = relative(toplevel, absolute);

  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') {
    throw new Error(`File is outside the repository (${toplevel}): ${file}`);
  }

  const relativePath = rel.split(sep).join('/');
  const tracked = await git(['ls-files', '--error-unmatch', '--', relativePath], { cwd: toplevel, nothrow: true });

  return { toplevel, relativePath, tracked: tracked.exitCode === 0 };
}

export async function getLineBlameInfo(file: string, lineRange: LineRange): Promise<LineInfo[]> {
  // Blame HEAD's blob rather than the working file, so clean filters and
  // textconv never alter the bytes compared against later. Not trimming keeps
  // the trailing `\r` of the last line in CRLF files.
  const output = await git([
    'blame',
    '--no-textconv',
    '-p',
    '-L',
    `${lineRange.start},${lineRange.end}`,
    'HEAD',
    '--',
    file,
  ]);
  const lines = bytesToByteString(output.stdoutBytes).split('\n');
  const result: LineInfo[] = [];
  const filenames = new Map<string, string>();
  let currentCommit = '';
  let currentOriginalLine = 0;
  let currentFinalLine = 0;

  for (const line of lines) {
    const header = line.match(BLAME_HEADER);

    if (header) {
      currentCommit = header[1];
      currentOriginalLine = Number.parseInt(header[2], 10);
      currentFinalLine = Number.parseInt(header[3], 10);
    } else if (line.startsWith('filename ')) {
      filenames.set(currentCommit, byteStringToText(line.slice('filename '.length)));
    } else if (line.startsWith('\t')) {
      const content = line.substring(1);
      result.push({
        lineNumber: currentFinalLine,
        content,
        commitHash: currentCommit,
        originalLineNumber: currentOriginalLine,
        originalFile: filenames.get(currentCommit) ?? file,
      });
      currentFinalLine++;
      currentOriginalLine++;
    }
  }

  return result;
}

export function dedupeLineInfos(lines: LineInfo[]): LineInfo[] {
  const seen = new Set<number>();
  return lines.filter((line) => {
    if (seen.has(line.lineNumber)) {
      return false;
    }
    seen.add(line.lineNumber);
    return true;
  });
}

export async function getCommitInfo(commitHash: string): Promise<{ hash: string; subject: string }> {
  const output = await gitText(['log', '-1', '--format=%H%n%s', commitHash]);
  const [hash, subject] = output.trim().split('\n');
  return { hash: hash.trim(), subject: (subject ?? '').trim() };
}

export async function getHeadCommit(): Promise<string> {
  return (await gitText(['rev-parse', 'HEAD'])).trim();
}

export async function createBackupBranch(originalBranch: string): Promise<string> {
  const timestamp = Date.now();
  const backupBranch = `backup/${originalBranch}/${timestamp}`;
  await git(['branch', backupBranch]);
  return backupBranch;
}

export async function getCurrentBranch(): Promise<string> {
  return (await gitText(['branch', '--show-current'])).trim();
}

export async function hasMergeCommitsInRange(earliestCommit: string): Promise<boolean> {
  const ranged = await git(['rev-list', '--merges', `${earliestCommit}^..HEAD`], { nothrow: true });
  const output = ranged.exitCode === 0 ? ranged.stdout : await gitText(['rev-list', '--merges', 'HEAD']);
  return output.trim() !== '';
}

export async function sortCommitsTopologically(hashes: string[]): Promise<string[]> {
  if (hashes.length <= 1) {
    return [...hashes];
  }

  const output = await gitText(['log', '--topo-order', '--reverse', '--format=%H', ...hashes]);
  const ordered = output.trim().split('\n').filter(Boolean);

  const wanted = new Set(hashes);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const hash of ordered) {
    if (wanted.has(hash) && !seen.has(hash)) {
      result.push(hash);
      seen.add(hash);
    }
  }

  for (const hash of hashes) {
    if (!seen.has(hash)) {
      result.push(hash);
    }
  }

  return result;
}

export async function groupReplacementsByCommit(
  lineInfos: LineInfo[],
  replacements: Map<number, string>,
): Promise<CommitReplacements[]> {
  const groups = new Map<string, { file: string; lines: Replacement[] }>();

  for (const info of lineInfos) {
    const replacement = replacements.get(info.lineNumber);

    if (replacement === undefined) {
      continue;
    }

    const existing = groups.get(info.commitHash) ?? { file: info.originalFile, lines: [] };

    existing.lines.push({
      lineNumber: info.originalLineNumber,
      headLineNumber: info.lineNumber,
      originalContent: info.content,
      replacementContent: encodeReplacement(info.content, replacement),
    });

    groups.set(info.commitHash, existing);
  }

  const entries = Array.from(groups.entries()).map(([commitHash, group]) => ({
    commitHash,
    file: group.file,
    lines: group.lines,
  }));

  if (entries.length <= 1) {
    return entries;
  }

  const ordered = await sortCommitsTopologically(entries.map((e) => e.commitHash));
  const orderIndex = new Map(ordered.map((hash, index) => [hash, index]));

  return entries.sort((a, b) => {
    const orderA = orderIndex.get(a.commitHash) ?? Infinity;
    const orderB = orderIndex.get(b.commitHash) ?? Infinity;
    return orderA - orderB;
  });
}

export async function hasRemoteCommits(): Promise<boolean> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { nothrow: true });
  return upstream.exitCode === 0;
}

export async function isGitRepoClean(): Promise<boolean> {
  const status = await gitText(['status', '--porcelain', '-uno']);
  return status.trim() === '';
}

export async function isRebaseInProgress(): Promise<boolean> {
  const gitDir = await git(['rev-parse', '--git-dir'], { nothrow: true });

  if (gitDir.exitCode !== 0) {
    return false;
  }

  const dir = gitDir.stdout.trim();
  return existsSync(`${dir}/rebase-merge`) || existsSync(`${dir}/rebase-apply`);
}

export async function purgeReflogAndGc(): Promise<void> {
  await git(['reflog', 'expire', '--expire=now', '--all']);
  await git(['gc', '--prune=now', '--aggressive'], { echo: true });
}

export async function getCommitsTouchingFile(filePath: string): Promise<string[]> {
  const output = await git(['log', '--follow', '--format=%H', '--', filePath], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

export async function getCommitsTouchingFileInRefs(
  filePath: string,
  tipArgs: readonly string[] = ['--all'],
): Promise<string[]> {
  const output = await git(['log', '--format=%H', ...tipArgs, '--', filePath], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

export async function listStashCommits(): Promise<string[]> {
  const output = await git(['stash', 'list', '--format=%H'], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

// Every place the original data could still be reachable from, except the
// backup branch (which holds it by design until the user deletes it). `--all`
// only sees the newest stash, so older stash entries are added explicitly. The
// reflog is deliberately left out: right after a rewrite it always still points
// at the old commits, until the storage purge.
export async function scanTipArgs(excludedRef?: string): Promise<string[]> {
  const exclude = excludedRef ? [`--exclude=${excludedRef}`] : [];
  return [...exclude, '--all', ...(await listStashCommits())];
}

export type IndexFlag = 'skip-worktree' | 'assume-unchanged';

// Paths marked skip-worktree (also how sparse checkout hides files) or
// assume-unchanged have a working copy git does not track, and a rewrite would
// overwrite it without `git status` ever having shown it as modified.
export async function getIndexFlag(path: string): Promise<IndexFlag | undefined> {
  const output = await git(['ls-files', '-v', '--', path], { nothrow: true });
  const tag = output.stdout.charAt(0);

  if (tag === 'S' || tag === 's') {
    return 'skip-worktree';
  }

  return tag !== '' && tag === tag.toLowerCase() && tag !== tag.toUpperCase() ? 'assume-unchanged' : undefined;
}

export async function findCommitsContainingLines(
  files: string[],
  contents: string[],
  tipArgs: readonly string[] = ['--all'],
): Promise<ContentHit[]> {
  const wanted = Array.from(new Set(contents.filter((content) => content.trim() !== '')));
  const hits: ContentHit[] = [];

  if (wanted.length === 0) {
    return hits;
  }

  for (const file of Array.from(new Set(files))) {
    for (const hash of await getCommitsTouchingFileInRefs(file, tipArgs)) {
      const shown = await git(['cat-file', 'blob', `${hash}:${file}`], { nothrow: true });

      if (shown.exitCode !== 0) {
        continue;
      }

      const fileLines = new Set(bytesToByteString(shown.stdoutBytes).split('\n'));
      const found = wanted.filter((content) => fileLines.has(content));

      if (found.length > 0) {
        hits.push({ hash, file, lines: found });
      }
    }
  }

  return hits;
}

export async function getRefsContaining(commitHash: string): Promise<string[]> {
  const output = await git(['for-each-ref', '--contains', commitHash, '--format=%(refname)'], { nothrow: true });
  return output.exitCode === 0 ? output.stdout.trim().split('\n').filter(Boolean) : [];
}

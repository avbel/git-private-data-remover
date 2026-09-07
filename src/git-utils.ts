import { $ } from 'bun';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CommitReplacements, ContentHit, LineInfo, LineRange, RepoFile, Replacement } from './types.ts';

export async function checkGitVersion(minVersion: string): Promise<void> {
  const versionOutput = await $`git --version`.text();
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
  const toplevel = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();
  const absolute = resolve(realpathSync(process.cwd()), file);
  const rel = relative(toplevel, absolute);

  if (rel === '' || isAbsolute(rel) || rel.split(sep)[0] === '..') {
    throw new Error(`File is outside the repository (${toplevel}): ${file}`);
  }

  const relativePath = rel.split(sep).join('/');
  const tracked = await $`git ls-files --error-unmatch -- ${relativePath}`.cwd(toplevel).nothrow().quiet();

  return { toplevel, relativePath, tracked: tracked.exitCode === 0 };
}

export async function getLineBlameInfo(file: string, lineRange: LineRange): Promise<LineInfo[]> {
  const output = await $`git blame -L ${lineRange.start},${lineRange.end} -p -- ${file}`.text();
  const lines = output.trim().split('\n');
  const result: LineInfo[] = [];
  const filenames = new Map<string, string>();
  let currentCommit = '';
  let currentOriginalLine = 0;
  let currentFinalLine = 0;

  for (const line of lines) {
    if (line.match(/^[a-f0-9]{40} /)) {
      const parts = line.split(' ');
      currentCommit = parts[0];
      currentOriginalLine = Number.parseInt(parts[1], 10);
      currentFinalLine = Number.parseInt(parts[2], 10);
    } else if (line.startsWith('filename ')) {
      filenames.set(currentCommit, line.slice('filename '.length));
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
  const output = await $`git log -1 --format=%H%n%s ${commitHash}`.text();
  const [hash, subject] = output.trim().split('\n');
  return { hash: hash.trim(), subject: (subject ?? '').trim() };
}

export async function getHeadCommit(): Promise<string> {
  return (await $`git rev-parse HEAD`.quiet().text()).trim();
}

export async function createBackupBranch(originalBranch: string): Promise<string> {
  const timestamp = Date.now();
  const backupBranch = `backup/${originalBranch}/${timestamp}`;
  await $`git branch ${backupBranch}`;
  return backupBranch;
}

export async function getCurrentBranch(): Promise<string> {
  return (await $`git branch --show-current`.text()).trim();
}

export async function hasMergeCommitsInRange(earliestCommit: string): Promise<boolean> {
  const ranged = await $`git rev-list --merges ${earliestCommit}^..HEAD`.nothrow().quiet();
  const output = ranged.exitCode === 0 ? ranged.text() : await $`git rev-list --merges HEAD`.quiet().text();
  return output.trim() !== '';
}

export async function sortCommitsTopologically(hashes: string[]): Promise<string[]> {
  if (hashes.length <= 1) {
    return [...hashes];
  }

  const output = await $`git log --topo-order --reverse --format=%H ${hashes}`.text();
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
      originalContent: info.content,
      replacementContent: replacement,
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
  try {
    await $`git rev-parse --abbrev-ref --symbolic-full-name @{u}`.quiet();
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepoClean(): Promise<boolean> {
  const status = await $`git status --porcelain -uno`.text();
  return status.trim() === '';
}

export async function isRebaseInProgress(): Promise<boolean> {
  try {
    const gitDir = (await $`git rev-parse --git-dir`.text()).trim();
    const merge = await Bun.file(`${gitDir}/rebase-merge`).exists();
    const apply = await Bun.file(`${gitDir}/rebase-apply`).exists();
    return merge || apply;
  } catch {
    return false;
  }
}

export async function purgeReflogAndGc(): Promise<void> {
  await $`git reflog expire --expire=now --all`;
  await $`git gc --prune=now --aggressive`;
}

export async function getCommitsTouchingFile(filePath: string): Promise<string[]> {
  try {
    const output = await $`git log --follow --format=%H -- ${filePath}`.text();
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function getCommitsTouchingFileInAllRefs(filePath: string): Promise<string[]> {
  const output = await $`git log --all --format=%H -- ${filePath}`.nothrow().quiet();
  return output.exitCode === 0 ? output.text().trim().split('\n').filter(Boolean) : [];
}

export async function findCommitsContainingLines(files: string[], contents: string[]): Promise<ContentHit[]> {
  const wanted = Array.from(new Set(contents.filter((content) => content.trim() !== '')));
  const hits: ContentHit[] = [];

  if (wanted.length === 0) {
    return hits;
  }

  for (const file of Array.from(new Set(files))) {
    for (const hash of await getCommitsTouchingFileInAllRefs(file)) {
      const shown = await $`git show ${hash}:${file}`.nothrow().quiet();

      if (shown.exitCode !== 0) {
        continue;
      }

      const fileLines = new Set(shown.text().split('\n'));
      const found = wanted.filter((content) => fileLines.has(content));

      if (found.length > 0) {
        hits.push({ hash, file, lines: found });
      }
    }
  }

  return hits;
}

export async function getRefsContaining(commitHash: string): Promise<string[]> {
  const format = '%(refname)';
  const output = await $`git for-each-ref --contains ${commitHash} --format=${format}`.nothrow().quiet();
  return output.exitCode === 0 ? output.text().trim().split('\n').filter(Boolean) : [];
}

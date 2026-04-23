import { $ } from 'bun';
import type { LineInfo, LineRange, Replacement, CommitReplacements } from './types.ts';

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

export async function getLineBlameInfo(file: string, lineRange: LineRange): Promise<LineInfo[]> {
  const output = await $`git blame -L ${lineRange.start},${lineRange.end} -p -- ${file}`.text();
  const lines = output.trim().split('\n');
  const result: LineInfo[] = [];
  let currentCommit = '';
  let currentOriginalLine = 0;
  let currentFinalLine = 0;

  for (const line of lines) {
    if (line.match(/^[a-f0-9]{40} /)) {
      const parts = line.split(' ');
      currentCommit = parts[0];
      currentOriginalLine = Number.parseInt(parts[1], 10);
      currentFinalLine = Number.parseInt(parts[2], 10);
    } else if (line.startsWith('\t')) {
      const content = line.substring(1);
      result.push({
        lineNumber: currentFinalLine,
        content,
        commitHash: currentCommit,
        originalLineNumber: currentOriginalLine,
      });
      currentFinalLine++;
      currentOriginalLine++;
    }
  }

  return result;
}

export async function getFileAtCommit(file: string, commitHash: string): Promise<string[]> {
  const output = await $`git show ${commitHash}:${file}`.text();
  return output.split('\n');
}

export async function getCommitInfo(commitHash: string): Promise<{ hash: string; subject: string }> {
  const output = await $`git log -1 --format=%H%n%s ${commitHash}`.text();
  const [hash, subject] = output.trim().split('\n');
  return { hash: hash.trim(), subject: subject.trim() };
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
  let output: string;
  try {
    output = await $`git rev-list --merges ${earliestCommit}^..HEAD`.text();
  } catch {
    output = await $`git rev-list --merges HEAD`.text();
  }
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
  const groups = new Map<string, Replacement[]>();

  for (const info of lineInfos) {
    const replacement = replacements.get(info.lineNumber);

    if (replacement === undefined) {
      continue;
    }

    const existing = groups.get(info.commitHash) || [];

    existing.push({
      lineNumber: info.originalLineNumber,
      originalContent: info.content,
      replacementContent: replacement,
    });

    groups.set(info.commitHash, existing);
  }

  const entries = Array.from(groups.entries()).map(([commitHash, lines]) => ({
    commitHash,
    lines,
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
    await $`git rev-parse --abbrev-ref --symbolic-full-name @{u}`;
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

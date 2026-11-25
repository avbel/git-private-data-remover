export interface LineRange {
  start: number;
  end: number;
}

export interface LineInfo {
  lineNumber: number;
  content: string;
  commitHash: string;
  originalLineNumber: number;
  originalFile: string;
}

export interface Replacement {
  /** Line number inside the originating commit. */
  lineNumber: number;
  /** Line number of the same line in the HEAD version of the file. */
  headLineNumber: number;
  originalContent: string;
  replacementContent: string;
}

export interface CommitReplacements {
  commitHash: string;
  file?: string;
  lines: Replacement[];
}

export type RewriteEngine = 'history' | 'rebase';

export interface RepoFile {
  toplevel: string;
  relativePath: string;
  tracked: boolean;
}

export interface ContentHit {
  hash: string;
  file: string;
  lines: string[];
  /** Replaces the default description; must never contain the private data itself. */
  note?: string;
}
